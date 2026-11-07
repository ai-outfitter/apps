/** Generate/check schema only from public legacy SQL in an isolated synthetic database. */
import { createClient } from "@libsql/client";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrateAppDatabase, type AppDatabaseExecutor } from "@ai-outfitter/app-sdk/migrations";
const root = new URL("../", import.meta.url);
const client = createClient({url:"file::memory:"});
try {
  const names=(await readdir(new URL("migrations/",root))).filter(name=>name.endsWith(".sql")).sort();
  let pinned: {baselines: {replaces: string[]}[]} | undefined;
  try {pinned=JSON.parse(await readFile(new URL("migration-baseline.json",root),"utf8"));} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  const selected=pinned ? names.filter(name=>pinned!.baselines[0].replaces.includes(name.slice(0,-4))) : names;
  if(pinned && selected.length!==pinned.baselines[0].replaces.length) throw Error("Pinned baseline references missing migrations");
  const migrations=await Promise.all(selected.map(async name=>({name:name.slice(0,-4),sql:await readFile(new URL(`migrations/${name}`,root),"utf8")})));
  const db:AppDatabaseExecutor={query:async sql=>(await client.execute(sql)).rows as unknown as Record<string,unknown>[],batch:async statements=>{await client.batch(statements,"write");}};
  await migrateAppDatabase(db,migrations);
  const schema=await client.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_outfitter_migrations' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name");
  const sql="-- Onto schema v1. Schema only; initialization owns standard JSON data.\n"+schema.rows.map(row=>String(row.sql).replace(/;$/,"")+";").join("\n--> statement-breakpoint\n")+"\n";
  const metadata=JSON.stringify({version:1,baselines:[{name:"0000_onto_schema_v1",file:"migrations/baselines/v1.sql",sha256:createHash("sha256").update(sql).digest("hex"),replaces:migrations.map(m=>m.name)}]},null,2)+"\n";
  if(process.argv.includes("--write")) {
    await writeFile(new URL("migrations/baselines/v1.sql",root),sql);await writeFile(new URL("migration-baseline.json",root),metadata);
  } else {
    if(await readFile(new URL("migrations/baselines/v1.sql",root),"utf8")!==sql || await readFile(new URL("migration-baseline.json",root),"utf8")!==metadata) throw Error("Baseline differs from public legacy schema; inspect before regenerating");
    console.log(`Verified Onto baseline: ${schema.rows.length} schema objects, ${migrations.length} legacy migrations; no seed rows`);
  }
} finally {client.close();}
