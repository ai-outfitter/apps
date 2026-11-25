import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { documentText } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { parseDirectUpload } from "@ai-outfitter/app-sdk/storage";
import { documents } from "../src/server/documents";
import { archive, hash, itemId, report, source, stl } from "./fixtures/print-package";

test("recording verifies actual stored geometry, keeps failed imports staged, and replays the verified receipt", async () => {
  const app=await appWorker("workshop",appArtifact(new URL("..",import.meta.url),"operational"),"print-package-verification");
  const member={userId:"builder",organizationId:"fixture-org",role:"member"};
  const bucket=await app.bucket("main");
  try {
    const project=await (await app.call("/api/apps/workshop/projects",member,{method:"POST",body:{example:"cube"}})).json() as {
      id:string;revision:number;
    };
    async function graph(name:"WorkshopPrint"|"RecordWorkshopPrintPlate"|"UpdateWorkshopAssembly"|"UploadWorkshopAssemblyFile",variables:unknown) {
      const response=await app.call("/api/internal/actions/v1/call",member,{method:"POST",body:{
        action:name==="WorkshopPrint"?"graph.graphql":"graph.mutate",
        input:{query:documentText(documents[name].document),variables},
      }});
      assert.equal(response.status,200);
      const result=await response.json() as {data?:Record<string,any>;errors?:{message:string}[]};
      if (result.errors?.length) throw Error(result.errors[0].message);
      return Object.values(result.data!)[0];
    }
    const rootId=randomUUID();
    const initial=await graph("UpdateWorkshopAssembly",{projectId:project.id,expectedRevision:project.revision,
      assembly:{rootId,items:[
        {id:rootId,name:"Bracket fixture",number:"FIXTURE",kind:"assembly",revision:"A",
          uses:[{id:randomUUID(),itemId,refdes:"P1",quantity:2,position:[0,0,0]}]},
        {id:itemId,name:"Bracket",number:"P1",kind:"printed",revision:"A"},
      ]},
    });
    async function put(url:string,bytes:Uint8Array) {
      const ticket=parseDirectUpload(url);
      assert.ok(ticket);
      await bucket.put(ticket.key,bytes);
    }
    async function attach(bytes:Uint8Array,expectedRevision:number) {
      const input={projectId:project.id,itemId,expectedRevision,fileName:"bracket.stl",sha256:hash(bytes),bytes:bytes.length,
        meshBounds:{min:[0,0,0],max:[2,3,1]}};
      const reserved=await graph("UploadWorkshopAssemblyFile",{input});
      if (reserved.status==="attached") return reserved;
      await put(reserved.upload.url,bytes);
      return graph("UploadWorkshopAssemblyFile",{input});
    }
    const replacement=await attach(stl(1.1),initial.revision);
    const artifactBytes=archive();
    const artifact={fileName:"plate.3mf",sha256:hash(artifactBytes),bytes:artifactBytes.length};
    const evidence={fileName:"result.json",sha256:hash(report),bytes:report.length};
    const record=(expectedRevision:number,sha256:string)=>graph("RecordWorkshopPrintPlate",{input:{
      projectId:project.id,expectedRevision,slicer:"Bambu Studio",artifact,result:evidence,
      plates:[{index:1,name:"Plate 1",members:[{itemId,sha256,quantity:2}]}],
    }});
    const pending=await record(replacement.revision,replacement.file.sha256);
    assert.equal(pending.status,"awaiting_upload");
    assert.equal(pending.uploads.length,2);
    for (const item of pending.uploads) await put(item.url,item.fileName===artifact.fileName?artifactBytes:report);
    await assert.rejects(record(replacement.revision,replacement.file.sha256),/Sliced geometry differs/);
    assert.equal(await bucket.head(`builds/${project.id}/print/${artifact.sha256}/${artifact.fileName}`),null);
    const corrected=await attach(source,replacement.revision);
    await assert.rejects(record(replacement.revision,corrected.file.sha256),/Project changed/);
    const saved=await record(corrected.revision,corrected.file.sha256);
    assert.equal(saved.status,"recorded");
    assert.deepEqual(await record(corrected.revision,corrected.file.sha256),saved);
    const read=()=>graph("WorkshopPrint",{input:{projectId:project.id}});
    assert.equal((await read()).plates[0].state,"completed");
    await attach(stl(1.1),saved.revision);
    assert.equal((await read()).plates[0].state,"stale");
  } finally {
    await app.dispose();
  }
});
