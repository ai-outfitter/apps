import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { createHash, randomUUID } from "node:crypto";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { ProjectSchema } from "../src/lib/project";

const member={userId:"pcb-builder",organizationId:"pcb-fixture",role:"member"};
test("PCB imports verify content, preserve assembly/workflows and reject forged or mutable evidence",async()=>{
 const app=await appWorker("workshop",appArtifact(new URL("..",import.meta.url),"operational"),"pcb-snapshot-import");
 try{
  const call=(path:string,body?:unknown,method=body?"POST":"GET")=>app.call(path,member,{method,...(body?{body}:{})});
  const created=await call("/api/apps/workshop/projects",{example:"cube"});assert.equal(created.status,201);
  const p=ProjectSchema.parse(await created.json());const url=`/api/apps/workshop/projects/${p.id}`;const snapshotId=randomUUID();
  const artifact=(name:string,data:string,contentType:string)=>{const bytes=Buffer.from(data),sha256=createHash("sha256").update(bytes).digest("hex");return {record:{path:`${sha256}/${name}`,sha256,bytes:bytes.length,contentType},base64:bytes.toString("base64")};};
  const source=artifact("source.tar","Source fixture; not actual ECAD","application/x-tar");
  const board=artifact("board.kicad_pcb","Native board fixture","text/plain");
  const model=artifact("board.glb","Model fixture","model/gltf-binary");
  const review={title:"Fixture",revision:"A",boardSha256:board.record.sha256,dimensions:"100 x 80",components:1,model:model.record.path,modelNote:"Test geometry",status:"Imported, not physically validated",parts:[{Reference:"U1",Quantity:"1",MPN:"ABC",Value:"MCU",Footprint:"QFN",Description:"Controller"}],checks:[],power:{modes:{idle:{input_w:.01,input_w_plus_20pct:.012}},inputVoltageV:12,marginPercent:20},powerNotes:"Fixture",manufacturingNote:"Not an order",downloads:[],quotes:[]};
  const metadata=artifact("pcb-review.json",JSON.stringify(review),"application/json");
  const all=[source,board,model,metadata];const now=new Date().toISOString();
  const manifest={version:1,units:"mm",sourceCommit:"a".repeat(40),sourceHash:source.record.sha256,compiler:"Fixture",runner:"Imported evidence",parameters:{},assembly:{items:[]},artifacts:all.map(a=>a.record),tests:[],notes:"Fixture",startedAt:now,finishedAt:now};
  const input={snapshotId,revision:p.revision,reviewPath:metadata.record.path,manifest};
  assert.equal((await call(url+"/pcb",{snapshotId,path:source.record.path,base64:"%%%",contentType:source.record.contentType},"PUT")).status,400,"Malformed base64");
  assert.equal((await call(url+"/pcb",input)).status,400,"Missing bytes must not create a snapshot");
  assert.equal((await call(url+"/pcb",{snapshotId,path:source.record.path,base64:Buffer.from("tampered").toString("base64"),contentType:source.record.contentType},"PUT")).status,400);
  for(const a of all)assert.equal((await call(url+"/pcb",{snapshotId,path:a.record.path,base64:a.base64,contentType:a.record.contentType},"PUT")).status,200);
  assert.equal((await call(url+"/pcb",{...input,revision:p.revision+1})).status,409,"Reject stale project revision");
  const imported=await call(url+"/pcb",input);assert.equal(imported.status,200,await imported.clone().text());
  const saved=ProjectSchema.parse(await imported.json());assert.equal(saved.pcbSnapshots?.length,1);assert.equal(saved.pcbSnapshots[0].origin,"imported");assert.deepEqual(saved.assembly,p.assembly);assert.deepEqual(saved.workspace,p.workspace);
  assert.equal((await call(url+"/pcb",{...input,revision:saved.revision})).status,409,"No duplicate snapshot ID");
  assert.equal((await call(url+"/pcb",{snapshotId,path:model.record.path,base64:model.base64,contentType:model.record.contentType},"PUT")).status,409,"Imported bytes are immutable");
  assert.equal((await call(url,{...saved,pcbSnapshots:[]},"PUT")).status,400,"Generic save cannot rewrite evidence");
  assert.equal((await call("/api/apps/workshop/projects",{project:{...saved,id:randomUUID()}})).status,400,"Project import cannot forge evidence");
  const normalSave=await call(url,{...saved,name:"Renamed after import"},"PUT");assert.equal(normalSave.status,200,await normalSave.clone().text());
  const renamed=ProjectSchema.parse(await normalSave.json());
  const badId=randomUUID();
  const bad=artifact("pcb-review.json","not JSON","application/json");
  for(const a of [source,board,model,bad])assert.equal((await call(url+"/pcb",{snapshotId:badId,path:a.record.path,base64:a.base64,contentType:a.record.contentType},"PUT")).status,200);
  assert.equal((await call(url+"/pcb",{snapshotId:badId,revision:renamed.revision,reviewPath:bad.record.path,manifest:{...manifest,artifacts:[source,board,model,bad].map(a=>a.record)}})).status,400,"Malformed review returns a client error");
  const bundle=await call(url+"/pcb?snapshot="+snapshotId);assert.equal(bundle.status,200);
  const contents=unzipSync(new Uint8Array(await bundle.arrayBuffer()));
  assert.equal(JSON.parse(strFromU8(contents["snapshot.json"])).id,snapshotId);
  for(const a of all)assert.equal(Buffer.from(contents[a.record.path]).toString("base64"),a.base64);
 }finally{await app.dispose();}
});
