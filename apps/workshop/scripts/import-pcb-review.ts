/** Import file evidence, not a workflow result.
 * Usage: import-pcb-review.ts BASE_URL PACKAGE_DIRECTORY PROJECT_ID [--cdp URL]
 * --cdp uses normal same-origin requests from an already signed-in browser.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { BuildManifestSchema } from "../src/lib/workspace";
import { parsePcbReview, pcbReviewArtifact } from "../src/lib/pcb-review";
import { ProjectSchema } from "../src/lib/project";
const [baseArg,directory,id,...flags]=process.argv.slice(2);
if(!baseArg||!directory||!id)throw Error("Supply Workshop URL, package directory and existing project ID");
const base=baseArg.replace(/\/$/,"");
const manifest=BuildManifestSchema.parse(JSON.parse(await readFile(resolve(directory,"manifest.json"),"utf8")));
const files=JSON.parse(await readFile(resolve(directory,"upload-map.json"),"utf8")) as Record<string,string>;
const reviewFile=pcbReviewArtifact(manifest.artifacts);
if(!reviewFile)throw Error("No PCB review document in package");
const buffers=new Map<string,Buffer>();
for(const artifact of manifest.artifacts){
  if(typeof files[artifact.path]!=="string")throw Error(`Missing upload map entry: ${artifact.path}`);
  const bytes=await readFile(resolve(directory,files[artifact.path]));
  if(bytes.length!==artifact.bytes||createHash("sha256").update(bytes).digest("hex")!==artifact.sha256)throw Error(`Local artifact mismatch: ${artifact.path}`);
  buffers.set(artifact.path,bytes);
}
parsePcbReview(JSON.parse(buffers.get(reviewFile.path)!.toString()),manifest.artifacts);
const cdpIndex=flags.indexOf("--cdp");
const browser=cdpIndex>=0?await (await import("playwright")).chromium.connectOverCDP(flags[cdpIndex+1]):undefined;
const page=browser?.contexts().flatMap(c=>c.pages()).find(p=>new URL(p.url()).origin===new URL(base).origin);
if(browser&&!page)throw Error("Open a signed-in Workshop page in this browser first");
async function call(path:string,method="GET",body?:unknown){
  const url=base+path;
  const options={method,headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})};
  const result=page?await page.evaluate(async({url,options})=>{const r=await fetch(url,{...options,credentials:"include"});return {status:r.status,text:await r.text()};},{url,options}):await fetch(url,options).then(async r=>({status:r.status,text:await r.text()}));
  if(result.status<200||result.status>=300)throw Error(`HTTP ${result.status}: ${result.text.slice(0,500)}`);
  try{return JSON.parse(result.text);}catch{throw Error("Expected Workshop JSON; check the signed-in session and app URL");}
}
try{
  const endpoint=`/api/apps/workshop/projects/${id}`;
  const project=ProjectSchema.parse(await call(endpoint));
  const existing=project.pcbSnapshots?.find(s=>JSON.stringify(s.manifest)===JSON.stringify(manifest)&&s.reviewPath===reviewFile.path);
  if(existing){console.log(JSON.stringify({projectId:id,snapshotId:existing.id,status:"already imported"}));}
  else{
    // Deterministic UUID: retries reuse partial uploads instead of abandoning them.
    const hash=createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const snapshotId=hash.slice(0,8)+"-"+hash.slice(8,12)+"-5"+hash.slice(13,16)+"-a"+hash.slice(17,20)+"-"+hash.slice(20,32);
    for(const artifact of manifest.artifacts){await call(endpoint+"/pcb","PUT",{snapshotId,path:artifact.path,base64:buffers.get(artifact.path)!.toString("base64"),contentType:artifact.contentType});console.log("Uploaded",artifact.path.split("/").at(-1));}
    const saved=ProjectSchema.parse(await call(endpoint+"/pcb","POST",{snapshotId,revision:project.revision,reviewPath:reviewFile.path,manifest}));
    console.log(JSON.stringify({projectId:id,revision:saved.revision,snapshotId,origin:"imported",workflowRun:false}));
  }
}finally{await browser?.close();}
