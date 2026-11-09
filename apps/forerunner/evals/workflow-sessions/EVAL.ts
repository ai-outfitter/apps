import {readFileSync} from "node:fs";
import {environment} from "@vercel/agent-eval/eval";
import {expect, test} from "vitest";

const candidate=JSON.parse(readFileSync("candidate.json","utf8"));
const original=JSON.parse(readFileSync("session.json","utf8"));
const calls=candidate.session.entries.filter((e:any)=>e.kind==="inference-start");
const answers=candidate.session.entries.filter((e:any)=>e.kind==="inference-result");
test("all selected calls completed without truncation",()=>{
  expect(candidate.session.run.status).toBe("complete");expect(calls.length).toBeGreaterThan(0);
  expect(answers).toHaveLength(calls.length);
  for(const answer of answers){expect(answer.data.error).toBeUndefined();expect(answer.data.finishReason).not.toBe("length");}
});
test("all conclusions cite supplied evidence and valid endpoints with bounded confidence",()=>{
  for(const call of calls){
    const answer=answers.find((e:any)=>e.parentId===call.id)?.data.output;
    expect(answer).toBeDefined();
    const refs=new Set(call.data.data.evidence.map((e:any)=>e.ref));
    const keys=new Set(answer.entities.map((e:any)=>e.key));
    expect(keys.size).toBe(answer.entities.length);
    for(const item of [...answer.entities,...answer.relationships]){
      expect(item.confidence).toBeGreaterThanOrEqual(0);expect(item.confidence).toBeLessThanOrEqual(1);
      expect(item.evidence.length).toBeGreaterThan(0);for(const ref of item.evidence)expect(refs.has(ref)).toBe(true);
    }
    for(const edge of answer.relationships){expect(keys.has(edge.from)).toBe(true);expect(keys.has(edge.to)).toBe(true);expect(edge.from).not.toBe(edge.to);}
  }
});
test("selected input evidence is conserved",()=>{
  const checkpoint=original.entries.find((e:any)=>e.id===candidate.session.branch.checkpointId);
  const expected=checkpoint.id==="analysis" ? checkpoint.data.samples.flatMap((sample:any)=>sample.records).slice(0,40).map((_:any,i:number)=>({ref:`e${i}`})) : checkpoint.data.data.evidence;
  const refs=(items:any[])=>[...new Set(items.filter(e=>e.ref!=="operating-user").map(e=>e.ref))].sort();
  expect(refs(calls.flatMap((e:any)=>e.data.data.evidence))).toEqual(refs(expected));
});
test("proposals are grounded and useful",async()=>{
  await expect(environment).toSatisfyCriterion("Read session.json and candidate.json. Candidate entities and relationships must be supported by the captured messages and ontology, distinguish inference from facts, and have defensible confidence scores. Do not penalize wording changes or assume the baseline is correct. Assess useful findings rather than just schema validity.");
},180000);
