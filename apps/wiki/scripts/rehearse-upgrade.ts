/** Rehearse on an offline SQLite snapshot. Never opens the source for writing. */
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {copyFileSync,constants,readFileSync,readdirSync,writeFileSync,chmodSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import assert from "node:assert/strict";
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
function tables(db:DatabaseSync){
 return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>name);
}
function digest(db:DatabaseSync,name:string){return hash(db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row=>JSON.stringify(row)).sort());}
export function rehearse(source:string,candidate:string,receipt:string){
 assert.notEqual(resolve(source),resolve(candidate),"Source and candidate must differ");
 assert.match(receipt,/\.local\.json$/,"Receipts must stay in private .local.json files");
 const sourceHash=createHash("sha256").update(readFileSync(source)).digest("hex");
 copyFileSync(source,candidate,constants.COPYFILE_EXCL);chmodSync(candidate,0o600);
 const db=new DatabaseSync(candidate);
 try{
  db.exec("PRAGMA foreign_keys=ON");
  const original=tables(db);assert.ok(!original.includes("wiki_documents"),"Snapshot has already been converted");
  const before=Object.fromEntries(original.map(name=>[name,digest(db,name)]));
  db.exec("BEGIN IMMEDIATE");
  try{for(const migration of readdirSync(new URL("../migrations/",import.meta.url)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name>="0012").sort()) db.exec(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8"));db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}
  for(const name of original)assert.equal(digest(db,name),before[name],`Archive changed: ${name}`);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row=>row.integrity_check),["ok"]);
  const counts=db.prepare("SELECT (SELECT count(*) FROM wiki_documents) documents,(SELECT count(*) FROM wiki_document_revisions) revisions,(SELECT count(*) FROM wiki_pages) pages").get() as {documents:number;revisions:number;pages:number};
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"),sourceHash,"Source snapshot changed");
  const result={sourceSha256:sourceHash,archiveTables:before,...counts,sourceUnchanged:true};
  writeFileSync(receipt,JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});
  return result;
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,candidate,receipt]=process.argv.slice(2);
 if(!source||!candidate||!receipt)throw new Error("Usage: node --import tsx scripts/rehearse-upgrade.ts source.sqlite candidate.sqlite receipt.local.json");
 const result=rehearse(source,candidate,receipt);
 console.log(JSON.stringify({documents:result.documents,revisions:result.revisions,pages:result.pages,sourceUnchanged:result.sourceUnchanged}));
}
