import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import catalog from "../graph/documents.json";
import { appWorker } from "./fixtures/initialized-worker";

const member = { userId: "member", organizationId: "org", role: "owner" };
const agent = { ...member, userId: "author", actor: { kind: "app" as const, id: "forerunner" } };
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
    async function call(name: string, variables: object, asMember = false, caller = asMember ? member : agent) {
      const doc = catalog.find(doc => doc.name === name);
      assert.ok(doc, `Published document ${name}`);
      counts[step] = (counts[step] ?? 0) + 1;
      const response = await app.call("/api/internal/actions/v1/call", caller, {
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
    const original = { title: "Eval submission", proposals: [proposal("$kept", "Kept"), proposal("$edit", "Draft"), proposal("$drop", "Drop")] };
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
    const originalRun = first.reviewRun.runId;
    step = "deniedReview";
    await assert.rejects(grouped("unauthorized", "review", { batchId, expectedVersion: 1, verdict: "approve", refs: ["$kept"] }), /member/i);
    const feedback = { batchId, expectedVersion: 1, verdict: "request_changes", refs: ["$edit", "$drop"], comment: "Correct the name and withdraw the duplicate." };
    step = "requestChanges";
    await assert.rejects(grouped("app-feedback", "review", feedback), /member/i);
    const requested = await grouped("request", "review", feedback, true);
    assert.deepEqual([requested.id, requested.submittedVersion, requested.state], [batchId, 1, "awaiting_review"]);
    await assert.rejects(grouped("held", "review", { batchId, expectedVersion: 1, verdict: "approve", refs: ["$edit"] }, true), /requested changes/);
    step = "memberReview";
    await grouped("approve", "review", { batchId, expectedVersion: 1, verdict: "approve", refs: ["$kept"] }, true);
    async function revise(key: string, title: string) {
      const input = { batchId, expectedVersion: 1, proposals: [proposal("$edit", title)], remove: ["$drop"] };
      return mode === "candidate" ? call("MutateBatchSubmission", { input: { requestKey: key, ...input } }) : grouped(key, "amend", input);
    }
    step = "correct";
    const second = await revise("correct", "Corrected");
    assert.deepEqual([second.id, second.submittedVersion, second.state], [batchId, 2, "awaiting_review"]);
    assert.notEqual(second.reviewRun.runId, originalRun);
    if (mode === "candidate") assert.deepEqual(second.reviewRefs, ["$edit"]);
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
    assert.equal(nodes[0].operations.length, 2);
    assert.equal(kept.decision.by, member.userId);
    assert.equal(kept.decision.submittedVersion, 1);
    assert.equal(edited.decision, null);
    const [feedbackReceipt] = nodes[0].changeRequests;
    assert.deepEqual(feedbackReceipt.refs, feedback.refs);
    const { decision } = feedbackReceipt;
    assert.deepEqual([decision.by, decision.submittedVersion, decision.verdict, decision.comment],
      [member.userId, 1, "request_changes", feedback.comment]);
    assert.equal(edited.operation.attributes.title, "Corrected");
    for (const [version, title] of [[1, "Draft"], [2, "Corrected"]] as const) {
      const { submission } = await call("BatchSubmission", { id: batchId, version });
      assert.deepEqual(submission.proposals.map((p: { ref: string }) => p.ref), version === 1 ? ["$kept", "$edit", "$drop"] : ["$kept", "$edit"]);
      assert.equal(submission.proposals.find((p: { ref: string }) => p.ref === "$edit").evidence[0].quote, title);
    }
    if (mode === "candidate") {
      step = "receiptGuards";
      await assert.rejects(revise("correct", "Changed key input"), /requestKey/);
      await assert.rejects(call("MutateBatchSubmission", { input: { requestKey: "terminal-ref", batchId, expectedVersion: 2, remove: ["$kept"] } }), /already decided/);
    }
    step = "rereview";
    const review = { batchId, expectedVersion: 2, verdict: "approve", refs: ["$edit"] };
    await assert.rejects(grouped("stale-review", "review", { ...review, expectedVersion: 1 }, true), /version changed/);
    await assert.rejects(grouped("unversioned-review", "review", { ...review, expectedVersion: undefined }, true), /expectedVersion/);
    const reviewed = await grouped("rereview", "review", review, true);
    assert.deepEqual([reviewed.id, reviewed.submittedVersion, reviewed.state], [batchId, 2, "committed"]);
    const { nodes: [final] } = await call("ChangeBatches", { ids: [batchId], details: true });
    assert.deepEqual(final.operations[0].decision, kept.decision);
    assert.deepEqual(final.changeRequests, nodes[0].changeRequests);
    assert.equal(final.operations[1].record, "Person:corrected");
    assert.equal(final.operations[1].decision.submittedVersion, 2);
    const journeyCalls = Object.entries(counts).reduce((total, [step, count]) => step === "receiptGuards" ? total : total + count, 0);
    let deletedDraft;
    if (mode === "candidate") {
      step = "deletion";
      const draft = await grouped("draft", "stage", { title: "Draft for deletion", proposals: [proposal("$draft", "Uncommitted")] });
      const input = { requestKey: "delete", batchId: draft.id, expectedVersion: 0, deleteBatch: true };
      const deleting = (fields: object = input) => call("MutateBatchSubmission", { input: fields });
      await assert.rejects(deleting({ ...input, expectedVersion: 1 }), /version changed/);
      await assert.rejects(deleting({ ...input, summary: "mixed" }), /only batchId/);
      await assert.rejects(deleting({ ...input, batchId, expectedVersion: 2 }), /open, never-submitted/);
      await assert.rejects(call("MutateBatchSubmission", { input }, false, { ...agent, actor: { ...agent.actor, id: "other-app" } }), /authenticated member/);
      deletedDraft = await deleting();
      assert.deepEqual([deletedDraft.id, deletedDraft.submittedVersion, deletedDraft.state, deletedDraft.reviewRun],
        [draft.id, 0, "discarded", null]);
      assert.deepEqual(await deleting(), deletedDraft);
      await assert.rejects(deleting({ ...input, requestKey: "again" }), /open, never-submitted/);
      await assert.rejects(grouped("resubmit-deleted", "submit", { batchId: draft.id }), /no longer open/);
      const { nodes: [discarded] } = await call("ChangeBatches", { ids: [draft.id], details: true });
      assert.equal(discarded.operations[0].ref, "$draft");
      assert.equal(discarded.operations[0].record, null);
    }
    t.diagnostic(JSON.stringify({ mode, counts, journeyCalls, batchId, originalRun, revisedRun: second.reviewRun.runId,
      finalVersion: final.submittedVersion, finalState: final.state, feedback: decision, deletedDraft }));
  });
}
