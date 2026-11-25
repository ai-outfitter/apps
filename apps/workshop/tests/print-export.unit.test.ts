import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { parseSlicedPrintPackage } from "../src/server/print-plates";

const manifestPath=process.env.WORKSHOP_REAL_PRINT_FIXTURE;
const sha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

test("a native Bambu Studio export retains both its estimates and geometry provenance", {skip:!manifestPath},async ()=>{
  const fixture=JSON.parse(await readFile(manifestPath!,"utf8")) as {
    archive:string;
    result:string;
    stlDirectory:string;
    replacement:{fileName:string;path:string};
    expectedPlates:{index:number;durationSeconds:number;filamentGrams:number}[];
  };
  const path=(file:string)=>resolve(dirname(manifestPath!),file);
  const artifact=await readFile(path(fixture.archive));
  const report=await readFile(path(fixture.result));
  const data=JSON.parse(report.toString()) as {sliced_plates:{id:number;objects:{name:string}[]}[]};
  const parts=new Map<string,{itemId:string;fileName:string;sha256:string;quantity:number}>();
  const membersByPlate=[];
  const loadPart=(part:{fileName?:string})=>readFile(path(fixture.stlDirectory+"/"+part.fileName));
  for (const plate of data.sliced_plates) {
    const members=new Map<string,{itemId:string;sha256:string;quantity:number}>();
    for (const object of plate.objects) {
      let part=parts.get(object.name);
      if (!part) {
        part={itemId:randomUUID(),fileName:object.name,sha256:sha256(await loadPart({fileName:object.name})),quantity:0};
        parts.set(object.name,part);
      }
      part.quantity++;
      const member=members.get(object.name)??{itemId:part.itemId,sha256:part.sha256,quantity:0};
      member.quantity++;
      members.set(object.name,member);
    }
    membersByPlate.push({index:plate.id,name:"Plate "+plate.id,members:[...members.values()]});
  }
  const correct=await parseSlicedPrintPackage(artifact,report,membersByPlate,[...parts.values()],loadPart);
  assert.deepEqual(correct.plates.map(({index,durationSeconds,filamentGrams})=>({index,durationSeconds,filamentGrams})),fixture.expectedPlates);
  const part=parts.get(fixture.replacement.fileName);
  assert.ok(part);
  const prior=await readFile(path(fixture.replacement.path));
  part.sha256=sha256(prior);
  for (const plate of membersByPlate) for (const member of plate.members) {
    if (member.itemId===part.itemId) member.sha256=part.sha256;
  }
  await assert.rejects(parseSlicedPrintPackage(artifact,report,membersByPlate,[...parts.values()],
    target=>target.itemId===part.itemId ? Promise.resolve(prior) : loadPart(target)),
    asyncError=>asyncError instanceof Response && asyncError.status===400);
});
