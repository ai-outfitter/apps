import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import catalog from "../graph/documents.json";
import { appWorker } from "./fixtures/initialized-worker";

const member = { userId: "member", organizationId: "org", role: "owner" };
const agent = { ...member, actor: { kind: "app" as const, id: "forerunner" } };
const proposal = (ref: string, title: string) => ({
  operation: { operation: "create", ref, type: "graph-node", attributes: { typeId: "Person", title } },
  evidence: [{ provider: "meeting", recordId: "eval", quote: title }],
});

for (const mode of ["baseline", "candidate"]) {
  test(`public submission journey: ${mode}`, async t => {
    const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "pair-eval");
    t.after(() => app.dispose());
    const counts: Record<string, number> = {};
    let step = "create";
    async function call(name: string, variables: object, asMember = false) {
      const doc = catalog.find(doc => doc.name === name);
      assert.ok(doc, `Published document ${name}`);
      counts[step] = (counts[step] ?? 0) + 1;
      const response = await app.call("/api/internal/actions/v1/call", asMember ? member : agent, {
        method: "POST", body: { action: doc.kind === "query" ? "graph.graphql" : "graph.mutate",
          input: { query: doc.query, operationName: name, variables } },
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      if (body.errors?.length) throw new Error(body.errors[0].message);
      return Object.values(body.data)[0] as Record<string, any>;
    }
    async function grouped(key: string, action: string, input: object, asMember = false) {
      const { items } = await call("ChangeBatchChanges", { input: { items: [{ key, action, input }] } }, asMember);
      if (items[0].error) throw new Error(items[0].error.message);
      return items[0].result;
    }
    const original = { title: "Eval submission", proposals: [proposal("$kept", "Kept"), proposal("$edit", "Draft")] };
    async function create() {
      if (mode === "candidate") return call("MutateBatchSubmission", { input: { ...original, requestKey: "create" } });
      const staged = await grouped("stage", "stage", original);
      return grouped("submit", "submit", { batchId: staged.id });
    }
    const first = await create();
    assert.equal(first.submittedVersion, 1);
    step = "createReplay";
    assert.deepEqual(await create(), first);
    const batchId = first.id;
    step = "deniedReview";
    await assert.rejects(grouped("unauthorized", "review", { batchId, expectedVersion: 1, verdict: "approve", refs: ["$kept"] }), /member/i);
    step = "memberReview";
    await grouped("approve", "review", { batchId, expectedVersion: 1, verdict: "approve", refs: ["$kept"] }, true);
    async function revise(key: string, title: string) {
      const input = { batchId, expectedVersion: 1, proposals: [proposal("$edit", title)] };
      return mode === "candidate" ? call("MutateBatchSubmission", { input: { requestKey: key, ...input } }) : grouped(key, "amend", input);
    }
    step = "correct";
    const second = await revise("correct", "Corrected");
    assert.equal(second.submittedVersion, 2);
    step = "correctionReplay";
    assert.deepEqual(await revise("correct", "Corrected"), second);
    step = "stale";
    await assert.rejects(revise("stale", "Lost update"), /version changed|stale|version mismatch/i);
    step = "persistedState";
    const { nodes } = await call("ChangeBatches", { ids: [batchId], details: true });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].submittedVersion, 2);
    const [kept, edited] = nodes[0].operations;
    assert.deepEqual([kept.ref, kept.state, kept.record, edited.ref, edited.state], ["$kept", "committed", "Person:kept", "$edit", "awaiting_review"]);
    assert.ok(kept.decision);
    assert.equal(edited.operation.attributes.title, "Corrected");
    for (const [version, title] of [[1, "Draft"], [2, "Corrected"]] as const) {
      const { submission } = await call("BatchSubmission", { id: batchId, version });
      assert.equal(submission.proposals.find((p: { ref: string }) => p.ref === "$edit").evidence[0].quote, title);
    }
    t.diagnostic(JSON.stringify({ mode, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }));
  });
}
