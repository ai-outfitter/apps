import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readdir,readFile,mkdir,rm,stat,writeFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,relative,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {normalizeUnusedIslandKey} from './normalize.mjs';
import {isManagedAssetPath,managedAssetContentType,isWorkerModuleName} from './paths.mjs';
import {storageMigration} from '@ai-outfitter/app-sdk/migrations';
import {readWorkflowPackage} from '@ai-outfitter/workflow-core/source';
import {z} from 'zod';
const dependencies=z.array(z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(16).refine(a=>new Set(a).size===a.length).parse;
function appWorkflows(directory) {
 const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
 return Object.entries(pkg.dependencies || {}).flatMap(([name,version])=>{
  let base=directory;
  while(true) {
   const candidate=join(base,'node_modules',name);
   if(existsSync(join(candidate,'package.json'))) {
    const dependency=JSON.parse(readFileSync(join(candidate,'package.json'),'utf8'));
    if(dependency.outfitter?.kind!=='workflow') return [];
    if(version!==dependency.version) throw Error('Workflow dependency must pin its package version');
    return [readWorkflowPackage(candidate)];
   }
   const parent=dirname(base);if(parent===base) return [];base=parent;
  }
 });
}
export function artifactPath(directory,mode) { return join(resolve(directory),'.outfitter','packages',`${mode}.json`); }
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
// The installation database's migrations, in the order they apply.
async function migrations(directory) {
  const folder = join(directory, "migrations");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
  if (!names.length) throw new Error(`No migrations in ${folder}`);
  return Promise.all(
    names.map(async (name) => ({
      name: name.slice(0, -".sql".length),
      sql: await readFile(join(folder, name), "utf8"),
    })),
  );
}
export async function buildApp(directory, {mode,output}={}) {
 directory=resolve(directory);
 const require=createRequire(join(directory,'package.json'));
 const template=JSON.parse(await readFile(join(directory,'app.json'),'utf8'));
 const slug=template.id;
 const modes=mode?[mode]:Object.keys(template.modes || {});
 if(!modes.length || modes.some(m=>!['demo','operational'].includes(m) || !template.modes[m])) throw Error('Declare supported app modes');
 if(output && modes.length!==1) throw Error('An output requires one explicit mode');
 const results=[];
 for(const mode of modes) {
 const artifactPath=output?resolve(directory,output):join(directory,'.outfitter/packages',`${mode}.json`);
  const { modes, ...base } = template;
  const manifest = {
    id: base.id,
    version: base.version,
    runtime: base.runtime,
    mode,
    capabilities: modes[mode].capabilities,
    workflows: appWorkflows(directory),
    ...(mode === "operational" ? { dependencies: dependencies(base.dependencies ?? []), initialize: base.initialize ?? false } : {}),
    dataLocation: base.dataLocation,
    // Demo packages serve fixtures and keep no records or files.
    ...(base.dataLocation === "installation-database" && mode === "operational"
      ? {
          database: { migrations: [...(base.storage ? [storageMigration] : []), ...await migrations(directory)] },
          ...(base.storage ? { storage: base.storage } : {}),
        }
      : {}),
  };
  await rm(join(directory, "dist"), { recursive: true, force: true });
  if (base.source === "single-html") {
    const server = join(directory, "dist/server");
    const client = join(directory, "dist/client/_astro");
    await mkdir(server, { recursive: true });
    await mkdir(client, { recursive: true });
    const html = await readFile(join(directory, "index.html"), "utf8");
    const adapter = await readFile(fileURLToPath(new URL("./html-worker.mjs", import.meta.url)), "utf8");
    await writeFile(join(server, "entry.mjs"),
      `const html = ${JSON.stringify(html)};\nconst app = ${JSON.stringify(slug.split("/").at(-1))};\n${adapter}\nexport default htmlWorker(html, app);`);
    await writeFile(join(client, "tokens.css"),
      await readFile(require.resolve("@ai-outfitter/ui/tokens.css")));
    await writeFile(join(server, "wrangler.json"), JSON.stringify({
      main: "entry.mjs", compatibility_date: "2026-10-03", compatibility_flags: [],
    }));
  } else {
    const result = spawnSync(
      process.execPath,
      [join(dirname(require.resolve("astro/package.json")), "bin/astro.mjs"), "build"],
      {
        cwd: directory,
        stdio: "inherit",
        env: { ...process.env, OUTFITTER_APP_MODE: mode },
      },
    );
    if (result.status !== 0)
      throw new Error(`App build failed: ${slug} (${mode})`);
  }
  const server = join(directory, "dist/server"),
    client = join(directory, "dist/client");
  const config = JSON.parse(
    await readFile(join(server, "wrangler.json"), "utf8"),
  );
  const modules = {};
  for (const path of await files(server)) {
    if (path.endsWith(".mjs") || path.endsWith(".js")) {
      const name = relative(server, path);
      if (!isWorkerModuleName(name))
        throw new Error(`Invalid Worker module name: ${name}`);
      modules[name] = await readFile(path, "utf8");
    }
  }
  normalizeUnusedIslandKey(modules);
  const assets = {};
  for (const path of await files(client)) {
    // _headers is Wrangler configuration, not a publicly served asset. The
    // dispatcher enforces private caching after checking membership on every request.
    if (
      ["_headers", "_redirects", ".assetsignore"].includes(
        relative(client, path),
      )
    )
      continue;
    const type = managedAssetContentType(path);
    if (!type)
      throw new Error(
        `Declare the asset content type before packaging ${path}`,
      );
    const assetPath = `/${relative(client, path)}`;
    if (!isManagedAssetPath(assetPath))
      throw new Error(`Invalid bundled asset path: ${assetPath}`);
    const bytes = await readFile(path);
    assets[assetPath] = {
      content: (type === "application/wasm"
        ? gzipSync(bytes, { level: 9 })
        : bytes
      ).toString("base64"),
      contentType: type,
      ...(type === "application/wasm"
        ? {
            encoding: "gzip",
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }
        : {}),
    };
  }
  const artifact = {
    mainModule: config.main,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    modules,
    assets,
  };
  if (!modules[artifact.mainModule] || !Object.keys(assets).length)
    throw new Error("Incomplete app build");
  await mkdir(dirname(artifactPath), { recursive: true });
  const bytes = JSON.stringify({ manifest, artifact });
  await writeFile(artifactPath, bytes);
  results.push(artifactPath);
  console.log(`Packaged ${slug} (${mode}): ${artifactPath}`);
 }
 return results;
}
