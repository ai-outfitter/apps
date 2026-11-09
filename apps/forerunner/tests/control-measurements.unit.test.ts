import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { responseMeasurement, quarterlyMeasurement } from "../scripts/control-measurements";

test("response formula preserves the deadline boundary, late failure, missing data and waivers", async () => {
  const db=createClient({url:":memory:"});
  try {
    const evaluate=async(addressed:number|null,asOf:number,complete=1,waived=0)=>{
      const result=await db.execute({sql:`WITH input AS (SELECT 0 AS triggered_at_epoch, ? AS addressed_at_epoch, ? AS as_of_epoch, 8 AS threshold, ? AS evidence_complete, ? AS waived) SELECT ${responseMeasurement.formula} AS result FROM input`,args:[addressed,asOf,complete,waived]});
      return result.rows[0].result;
    };
    assert.equal(await evaluate(8*3600,8*3600),"met");
    assert.equal(await evaluate(8*3600+1,9*3600),"breached");
    assert.equal(await evaluate(null,7*3600),"pending");
    assert.equal(await evaluate(null,8*3600),"breached");
    assert.equal(await evaluate(null,9*3600,0),"unknown");
    assert.equal(await evaluate(null,9*3600,1,1),"waived");
  } finally {db.close();}
});

test("quarterly formula counts distinct confirmed completions inside the half-open window", async () => {
  const db=createClient({url:":memory:"});
  try {
    await db.execute("CREATE TABLE interactions (interaction_id TEXT, confirmed INTEGER, completed_at_epoch INTEGER)");
    await db.execute("INSERT INTO interactions VALUES ('done',1,10),('done',1,10),('planned',0,20),('boundary',1,100),('future',1,90)");
    const count=await db.execute(`SELECT ${quarterlyMeasurement.measurement_formula} AS n FROM interactions CROSS JOIN (SELECT 0 AS quarter_start_epoch,100 AS quarter_end_epoch,50 AS as_of_epoch)`);
    assert.equal(count.rows[0].n,1);
    const evaluate=async(n:number,asOf:number,complete=1)=>{
      const result=await db.execute({sql:`WITH input AS (SELECT ? AS confirmed_count,1 AS threshold,? AS as_of_epoch,100 AS quarter_end_epoch,? AS evidence_complete) SELECT ${quarterlyMeasurement.formula} AS result FROM input`,args:[n,asOf,complete]});
      return result.rows[0].result;
    };
    assert.equal(await evaluate(1,50,0),"met");
    assert.equal(await evaluate(0,50),"pending");
    assert.equal(await evaluate(0,100),"not_met");
    assert.equal(await evaluate(0,100,0),"unknown");
  } finally {db.close();}
});

test("aggregate formula includes overdue failures and excludes pending, unknown and waived rows", async () => {
  const db=createClient({url:":memory:"});
  try {
    await db.execute("CREATE TABLE evaluations (result TEXT, due_at_epoch INTEGER, as_of_epoch INTEGER)");
    await db.execute("INSERT INTO evaluations VALUES ('met',10,20),('breached',10,20),('met',30,20),('pending',30,20),('unknown',10,20),('waived',10,20)");
    const result=await db.execute(`SELECT ${responseMeasurement.aggregation_formula} AS percentage FROM evaluations`);
    assert.equal(result.rows[0].percentage,50);
    await db.execute("DELETE FROM evaluations");
    assert.equal((await db.execute(`SELECT ${responseMeasurement.aggregation_formula} AS percentage FROM evaluations`)).rows[0].percentage,null);
  } finally {db.close();}
});

test("structured bodies validate and the compiler rejects unknown inputs and invalid operators", async () => {
  const {documentSchema}=await import("@ai-outfitter/app-sdk/agent-schema");
  const {readFileSync}=await import("node:fs");
  const {compileMeasurement,responseDefinition,quarterlyDefinition}=await import("../scripts/control-measurements");
  const types=JSON.parse(readFileSync(new URL("../../onto/seeds/control-pilot-types-v1.json",import.meta.url),"utf8"));
  const schema=documentSchema(types.find((type:{name:string})=>type.name==="ControlDefinition").jsonSchema);
  for(const body of [responseDefinition,quarterlyDefinition]) assert.deepEqual(schema.parse(body),body);
  assert.equal(schema.safeParse({...responseDefinition,window:{...responseDefinition.window,amount:0}}).success,false);
  const missing=structuredClone(responseDefinition);
  missing.programs.measurement[0].arguments[0]={input:"undefined_column"};
  assert.throws(()=>compileMeasurement(missing),/Unknown input/);
  const cycle=structuredClone(responseDefinition);
  cycle.programs.measurement[0].arguments[0]={step:"hours"};
  assert.throws(()=>compileMeasurement(cycle),/Unknown or forward step/);
  const mismatch=structuredClone(responseDefinition);
  mismatch.programs.measurement[0].arguments[0]={input:"waived"};
  assert.throws(()=>compileMeasurement(mismatch),/Expected numeric/);
});
