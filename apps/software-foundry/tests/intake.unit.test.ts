import assert from "node:assert/strict";
import test from "node:test";
import { boundedWorkReadback, outputChanges, submitInput } from "../src/server/intake";

test("only complete pinned workflow changes become result candidates", () => {
  const change = { number: 22, headSha: "a".repeat(40) };
  assert.deepEqual(outputChanges({
    pending: { complete: false, value: { number: 23, headSha: "b".repeat(40) } },
    implementation: { complete: true, value: { change } },
    duplicate: { complete: true, value: change },
    unpinned: { complete: true, value: { number: 24, url: "https://example.com/pr/24" } },
  }), [change]);
});

test("project targets and frozen criteria preserve revision-bound identities", () => {
  const base = { target: {project:"configured"}, requestId:"aaaaaaaa-1111-4111-8111-111111111111", title:"Work", description:"Description", acceptanceCriteria:["Done"] };
  const ref = { installationId:"wiki",type:"AcceptanceCriterion",id:"criterion",revision:2 };
  const input = { ...base, workPackage:{version:1,rendered:"Brief",digest:"a".repeat(64),sources:[ref],criteria:[{...ref,condition:"When ready",expectedOutcome:"Done"}]} };
  assert.deepEqual(submitInput.parse(input).workPackage?.criteria[0], input.workPackage.criteria[0]);
  assert.equal(submitInput.safeParse({...base,target:{}}).success,false);
  assert.equal(submitInput.safeParse({...input,workPackage:{...input.workPackage,criteria:[{...ref,revision:0,condition:"When",expectedOutcome:"Done"}]}}).success,false);
});

test("oversized readback fails explicitly instead of silently omitting required evidence", () => {
  assert.throws(()=>boundedWorkReadback({evidence:"x".repeat(480*1024)}),error=>error instanceof Response && error.status === 413);
});
