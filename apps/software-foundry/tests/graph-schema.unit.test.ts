import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/software-foundry/scripts/graph-schema.ts");
  // Every document is a mutation documents.ts runs or a query agents are pointed at.
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.filter((row:{hidden?:boolean})=>!row.hidden).map((row:{name:string;kind:string})=>[row.name,row.kind]),[
    ["JobChanges","mutation"],["RepositoryChanges","mutation"],["RequestChanges","mutation"],["Requests","query"],["SubmitReleaseEvidence","mutation"],
  ]);
  for (const name of ["SubmitWork","StartWork","RequestFeature","WorkChanges"]) assert.equal(committed.some((row:{name:string})=>row.name===name),false,`${name} is gone: RequestChanges is the one front door`);
});
