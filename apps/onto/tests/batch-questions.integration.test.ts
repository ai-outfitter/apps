import { print } from "graphql";
import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { documents } from "../src/server/documents";
import { core } from "../src/lib/graph";
import { create, definitions } from "./fixtures/relators";

// Questions on a batch (docs/plans/agent-questions.md): an agent asks, a reviewer answers on
// the Changes page, the agent revises citing the answer. Answering approves nothing.
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const agent = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const connection = { ...owner, actor: { kind: "oauth-client" as const, id: "member-mcp" } };
const uuid = (n: number) => `7c0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (ref: string, n: number, title: string) => create(ref, "graph-node", { id: uuid(n), typeId: core.person, title });

// biome-ignore lint/suspicious/noExplicitAny: public JSON responses under test.
async function json(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function fixture() {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async (_operation, input) => ({ ok: true, value: { ...(input as object), state: "running", replyEntryIds: [] } }) }),
  });
  const action = (name: string, input: object, identity: object = owner) =>
    app.call("/api/internal/actions/v1/call", identity as typeof owner, { method: "POST", body: { action: name, input } });
  await json(await action("graph.apply", { requestKey: "definitions", operations: definitions() }));
  const changes = async (action: string, input: object, identity: object = agent) => {
    const result = await json(await app.call("/api/internal/actions/v1/call", identity as typeof owner, { method: "POST", body: { action: "graph.mutate", input: {
      query: print(documents.ChangeBatchChanges.document), operationName: "ChangeBatchChanges", variables: { input: { items: [{ key: crypto.randomUUID(), action, input }] } },
    } } }));
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return result.data.changeBatchChanges.items[0];
  };
  const answer = (input: object, identity: object = owner) =>
    app.call("/api/apps/onto/batches/answer", identity as typeof owner, { method: "POST", body: input });
  const details = async (batchId: string) => (await json(await action("graph.graphql", {
    query: documents.ChangeBatches.document, variables: { ids: [batchId], details: true },
  }))).data.changeBatches.nodes[0];
  return { app, action, changes, answer, details };
}

const board = { key: "board-role", ask: "Who signs off flight hardware?", refs: ["$shen"], options: ["Shen Ge alone", "Both directors"] };

test("an agent asks on its batch, a reviewer answers, and the agent revises citing the answer", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const staged = await f.changes("stage", { title: "Board", anchors: [], proposals: [{ operation: person("$shen", 1, "Shen Ge") }, { operation: person("$lu", 2, "Lu") }] });
  const batchId = staged.result.id;

  // Questions name proposals in the batch.
  assert.equal((await f.changes("ask", { batchId, questions: [{ ...board, refs: ["$missing"] }] })).status, "uncertain");
  const asked = await f.changes("ask", { batchId, questions: [board, { key: "lu-title", ask: "What is Lu's title?" }] });
  assert.equal(asked.status, "complete");
  assert.deepEqual(asked.result.questions.map((item: { key: string }) => item.key), ["board-role", "lu-title"]);

  // Agents and members read questions from ChangeBatches details and the batch itself.
  assert.deepEqual((await f.details(batchId)).questions[0], { ...board });
  const inspected = await json(await f.action("graph.graphql", { query: documents.ChangeBatch.document, operationName: "ChangeBatch", variables: { id: batchId } }));
  assert.equal(inspected.data.changeBatch.questions.length, 2);

  await f.changes("submit", { batchId });
  // An agent may still ask while the batch waits for review; the same key replaces a question.
  const replaced = await f.changes("ask", { batchId, questions: [{ key: "lu-title", ask: "What is Lu's role on the board?", refs: ["$lu"] }] });
  assert.equal(replaced.result.questions[1].ask, "What is Lu's role on the board?");

  // Only reviewers answer: not an app, a delegated writer or a read-only member.
  for (const identity of [agent, { ...owner, entityWriter: { installationId: "delegator" } }, { ...owner, role: "viewer" }])
    assert.equal((await f.answer({ batchId, key: "board-role", option: "Both directors" }, identity)).status, 403, JSON.stringify(identity));
  assert.equal((await f.answer({ batchId, key: "board-role", option: "Nobody" })).status, 400);
  assert.equal((await f.answer({ batchId, key: "nope", text: "x" })).status, 404);

  // Answering approves nothing.
  const answered = await json(await f.answer({ batchId, key: "board-role", option: "Both directors" }));
  assert.deepEqual(answered.counts, { awaiting_review: 2 });
  assert.equal(answered.batch.questions[0].answer.option, "Both directors");
  assert.equal(answered.batch.questions[0].answer.by, "owner");
  const typed = await json(await f.answer({ batchId, key: "lu-title", text: "Treasurer" }));
  assert.equal(typed.batch.questions[1].answer.text, "Treasurer");

  // Re-asking the same question keeps its answer; rewording it needs a new one.
  const kept = await f.changes("ask", { batchId, questions: [{ ...board, refs: ["$shen", "$lu"] }] });
  assert.equal(kept.result.questions[0].answer.option, "Both directors");
  const reworded = await f.changes("ask", { batchId, questions: [{ key: "lu-title", ask: "What is Lu's title now?" }] });
  assert.equal(reworded.result.questions[1].answer, undefined);
  const removed = await f.changes("ask", { batchId, remove: ["lu-title"] });
  assert.equal(removed.result.questions.length, 1);

  // The agent cites the answer when it fixes the proposal; an unanswered citation is refused.
  const cite = (key: string) => [{ provider: "onto", recordId: `batch:${batchId}#${key}`, quote: "Both directors" }];
  const refused = await f.changes("amend", { batchId, proposals: [{ operation: person("$shen", 1, "Shen Ge, director"), evidence: cite("lu-title") }] }, connection);
  assert.equal(refused.status, "uncertain");
  assert.match(refused.error.message, /names no answered question/);
  const revised = await f.changes("amend", { batchId, proposals: [{ operation: person("$shen", 1, "Shen Ge, director"), evidence: cite("board-role") }] }, connection);
  assert.equal(revised.status, "pending");
  const { operations } = await json(await f.action("batch.get", { batchId }));
  assert.deepEqual(operations[0].evidence, cite("board-role"));

  // The Home card counts open questions on the batch's line.
  const card = await json(await f.app.call("/api/internal/home-cards/v1/read", owner, { method: "POST", body: { cardId: "changes-review", size: "medium" } }));
  assert.match(JSON.stringify(card), /Waiting for your approval/);
  await f.changes("ask", { batchId, questions: [{ key: "lu-title", ask: "What is Lu's title now?" }] });
  const counted = await json(await f.app.call("/api/internal/home-cards/v1/read", owner, { method: "POST", body: { cardId: "changes-review", size: "medium" } }));
  assert.match(JSON.stringify(counted), /Waiting for your approval · 1 question"/);

  // An unanswered question never blocks approval, and questions close with the batch.
  const approved = await json(await f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId, expectedVersion: 2, verdict: "approve" } }));
  assert.equal(approved.batch.state, "committed");
  assert.equal((await f.answer({ batchId, key: "lu-title", text: "Treasurer" })).status, 409);
  assert.equal((await f.changes("ask", { batchId, questions: [board] })).status, "uncertain");
  assert.doesNotMatch(JSON.stringify(await json(await f.app.call("/api/internal/home-cards/v1/read", owner, { method: "POST", body: { cardId: "changes-review", size: "medium" } }))), /question/);
});

test("app agents ask through the internal batch.ask action", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const { batch } = await json(await f.action("batch.open", { title: "From an app", anchors: [] }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: person("$shen", 11, "Shen Ge") }] }, agent));
  const asked = await json(await f.action("batch.ask", { batchId: batch.id, questions: [board] }, agent));
  assert.equal(asked.batch.questions[0].key, "board-role");
  // A policy batch takes questions only from the app that opened it.
  const policy = await json(await f.action("batch.open", { title: "Policy", anchors: [], policy: { kind: "confidence", threshold: 0.95, version: "v1" } }, agent));
  assert.equal((await f.action("batch.ask", { batchId: policy.batch.id, questions: [{ key: "x", ask: "Why?" }] }, connection)).status, 403);
});
