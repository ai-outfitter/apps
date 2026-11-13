import { print } from "graphql";
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { drizzle } from "drizzle-orm/d1";
import { documents } from "../src/server/documents";
import { sealDueBatches } from "../src/server/graph-batches";
import { batchReviewUrl } from "../src/server/graphql";
import { core } from "../src/lib/graph";
import { create, definitions, ids } from "./fixtures/relators";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
// Forerunner calling the Wiki, as platform dispatch forwards it: the member's identity, the app as actor, no entity writer.
const agent = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const actions = "/api/internal/actions/v1/call";
const uuid = (n: number) => `7b0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cite = (recordId: string) => [{ provider: "gmail", recordId, quote: "Climbing on Thursday?" }];
const person = (ref: string, n: number, title: string) => create(ref, "graph-node", { id: uuid(n), typeId: core.person, title });
const friends = (ref: string, n: number, from: number, to: number) =>
  create(ref, "graph-edge", { id: uuid(n), typeId: ids.friend, fromId: uuid(from), toId: uuid(to) });

// biome-ignore lint/suspicious/noExplicitAny: public JSON responses under test.
async function json(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function fixture() {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async (operation, input) => {
      assert.equal(operation, "threads.submission");
      return { ok: true, value: { ...(input as object), state: "running", replyEntryIds: [] } };
    } }),
  });
  const action = (name: string, input: object, identity: object = owner) =>
    app.call(actions, identity as typeof owner, { method: "POST", body: { action: name, input } });
  await json(await action("graph.apply", { requestKey: "definitions", operations: definitions() }));
  const exists = async (id: string) =>
    (await json(await action("graph.query", { queries: [{ name: "q", ids: [id] }] }))).queries.q.matches.length > 0;
  // The Changes page's routes: a member's review, and a record's history.
  const review = (input: object, identity: object = owner) =>
    app.call("/api/apps/onto/batches/review", identity as typeof owner, { method: "POST", body: input });
  const history = async (id: string) => json(await app.call(`/api/apps/onto/batches/history?id=${id}`, owner));
  return { app, action, exists, review, history };
}

test("operations added over several calls stay invisible until a member approves them", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const { batch } = await json(await f.action("batch.open", { title: "Discovery", source: { kind: "discovery-run", ref: "run-1" } }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: person("$ada", 1, "Ada"), evidence: cite("m1"), confidence: 0.8 }] }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: person("$bea", 2, "Bea"), evidence: cite("m2"), confidence: 0.8 }] }, agent));
  const edge = create("$friends", "graph-edge", { id: uuid(3), typeId: ids.friend, fromId: "$ada", toId: "$bea" });
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: edge, evidence: cite("m3"), confidence: 0.8, reason: "They plan climbing together." }] }, agent));
  // Re-adding an identical proposal is a no-op.
  assert.equal((await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: edge, evidence: cite("m3"), confidence: 0.8, reason: "They plan climbing together." }] }, agent))).added, 0);
  assert.equal(await f.exists(uuid(1)), false);

  const submitted = await json(await f.action("batch.submit", { batchId: batch.id, summary: "Two people and a friendship" }, agent));
  assert.equal(submitted.batch.state, "awaiting_review");
  assert.equal(submitted.counts.awaiting_review, 3);
  assert.equal(await f.exists(uuid(1)), false);

  // An agent cannot approve its own batch.
  assert.equal((await f.review({ batchId: batch.id, verdict: "approve" }, agent)).status, 403);
  // Approving the edge also approves the people it connects.
  const reviewed = await json(await f.review({ batchId: batch.id, refs: ["$friends"], verdict: "approve" }));
  assert.equal(reviewed.batch.state, "committed");
  assert.equal(reviewed.counts.committed, 3);
  assert.equal(await f.exists(uuid(1)), true);

  const history = await f.history(uuid(1));
  assert.equal(history.revisions[0].batchId, batch.id);
  assert.equal(history.revisions[0].approval.kind, "member");
  assert.equal(history.revisions[0].evidence[0].recordId, "m1");
  assert.equal(history.complete, true);
});

test("a confidence policy commits only confident operations whose dependencies also qualify", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const policy = { kind: "confidence", threshold: 0.95, version: "test-1" };
  const { batch } = await json(await f.action("batch.open", { title: "Daily", source: { kind: "discovery-run", ref: "run-2" }, policy }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: person("$ada", 11, "Ada"), evidence: cite("m1"), confidence: 0.97 },
    { operation: person("$bea", 12, "Bea"), evidence: cite("m2"), confidence: 0.5 },
    { operation: friends("$friends", 13, 11, 12), evidence: cite("m3"), confidence: 0.99 },
  ] }, agent));
  const submitted = await json(await f.action("batch.submit", { batchId: batch.id }, agent));
  assert.equal(submitted.batch.state, "awaiting_review");
  assert.deepEqual(submitted.operations.map((op: { ref: string; state: string }) => [op.ref, op.state]),
    [["$ada", "committed"], ["$bea", "awaiting_review"], ["$friends", "awaiting_review"]]);
  assert.equal(submitted.operations[0].decision.kind, "policy");
  assert.equal(submitted.operations[0].decision.score, 0.97);
  // Rejecting a person also rejects the friendship that needs them.
  const rejected = await json(await f.review({ batchId: batch.id, refs: ["$bea"], verdict: "reject" }));
  assert.equal(rejected.batch.state, "committed");
  assert.equal(rejected.counts.rejected, 2);
  assert.equal(await f.exists(uuid(12)), false);
  assert.equal(await f.exists(uuid(11)), true);
});

test("a review window seals what is still waiting, by policy", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const policy = { kind: "confidence", threshold: 0.95, version: "test-1", reviewWindow: { hours: 1 } };
  const { batch } = await json(await f.action("batch.open", { title: "Daily", source: { kind: "discovery-run", ref: "run-3" }, policy }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: person("$cy", 21, "Cy"), evidence: cite("m1"), confidence: 0.6 }] }, agent));
  const submitted = await json(await f.action("batch.submit", { batchId: batch.id }, agent));
  assert.ok(submitted.batch.reviewBy > Date.now());
  const db = drizzle(f.app.database);
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  assert.equal((await sealDueBatches(db, who)).sealed, 0);
  assert.equal((await sealDueBatches(db, who, Date.now() + 2 * 3600 * 1000)).sealed, 1);
  const sealed = await json(await f.action("batch.get", { batchId: batch.id }));
  assert.equal(sealed.batch.state, "committed");
  assert.equal(sealed.operations[0].decision.reason, "review-window");
  assert.equal(await f.exists(uuid(21)), true);
});

test("a first run commits everything once per Wiki", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const policy = { kind: "first-run", version: "test-1" };
  const source = { kind: "discovery-run", ref: "run-4" };
  const { batch } = await json(await f.action("batch.open", { title: "First run", source, policy }, agent));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: person("$di", 31, "Di"), evidence: cite("m1"), confidence: 0.4 }] }, agent));
  const submitted = await json(await f.action("batch.submit", { batchId: batch.id }, agent));
  assert.equal(submitted.batch.state, "committed");
  assert.equal(submitted.operations[0].decision.reason, "first-run");
  assert.equal((await f.action("batch.open", { title: "Again", source: { ...source, ref: "run-5" }, policy }, agent)).status, 409);
});

test("an open first run already counts, so a second first run is refused", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const policy = { kind: "first-run", version: "test-1" };
  await json(await f.action("batch.open", { title: "First", source: { kind: "discovery-run", ref: "a" }, policy }, agent));
  assert.equal((await f.action("batch.open", { title: "Also first", source: { kind: "discovery-run", ref: "b" }, policy }, agent)).status, 409);
});

test("a batch over 100 operations validates refs across add calls and commits in chunks", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const { batch } = await json(await f.action("batch.open", { title: "Large" }, agent));
  const people = Array.from({ length: 101 }, (_, n) => ({ operation: person(`$p${n}`, 100 + n, `Person ${n}`) }));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: people.slice(0, 100) }, agent));
  // The edge refers to a person added by the previous call.
  const edge = create("$link", "graph-edge", { id: uuid(300), typeId: ids.friend, fromId: "$p0", toId: "$p100" });
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [people[100], { operation: edge }] }, agent));
  await json(await f.action("batch.submit", { batchId: batch.id }, agent));
  const reviewed = await json(await f.review({ batchId: batch.id, verdict: "approve" }));
  assert.equal(reviewed.batch.state, "committed");
  assert.equal(reviewed.counts.committed, 102);
  assert.equal(await f.exists(uuid(200)), true);
  // The edge committed in the second chunk, with its endpoint from the first.
  assert.equal((await f.history(uuid(300))).revisions[0].batchId, batch.id);
});

test("an invalid batch cannot be submitted, and a threshold below the floor is refused", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  assert.equal((await f.action("batch.open", { title: "Loose", policy: { kind: "confidence", threshold: 0.5, version: "x" } }, agent)).status, 400);
  const { batch } = await json(await f.action("batch.open", { title: "Bad edge" }, agent));
  // A friendship needs people at both ends.
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: friends("$bad", 41, 99, 98) }] }, agent));
  const refused = await f.action("batch.submit", { batchId: batch.id }, agent);
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /Fix the batch before submitting it/);
});

test("direct graph.apply writes record history without a batch", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "direct", operations: [person("$eve", 51, "Eve")] }));
  const history = await f.history(uuid(51));
  assert.equal(history.revisions[0].batchId, null);
  assert.equal(history.revisions[0].approval.kind, "direct");
});

// The documents agents run: graph_mutate sends them to graph.mutate, graph_query to graph.graphql.
const run = (f: Awaited<ReturnType<typeof fixture>>, name: keyof typeof documents, variables: object, identity: object = agent) =>
  f.action(name === "ChangeBatch" ? "graph.graphql" : "graph.mutate", { query: typeof documents[name].document === "string" ? documents[name].document : print(documents[name].document), operationName: name, variables }, identity).then(json);

test("an agent stages, takes back and submits changes with documents; a member commits them", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const source = { kind: "meeting", ref: "meeting-1", label: "Kickoff" };
  const staged = await run(f, "StageChanges", { input: { title: "From a meeting", source, proposals: [{ operation: person("$ada", 61, "Ada"), evidence: cite("m1"), reason: "Introduced herself." }] } });
  assert.equal(staged.errors, undefined);
  const batchId = staged.data?.stageChanges.id;
  // The batch names where its proposals came from, as Forerunner's name their run.
  assert.deepEqual((await json(await f.action("batch.get", { batchId }, agent))).batch.source, source);
  assert.deepEqual([staged.data?.stageChanges.state, staged.data?.stageChanges.counts], ["open", { pending: 1 }]);
  const inspected = (await run(f, "ChangeBatch", { id: batchId }, owner)).data?.changeBatch;
  assert.deepEqual(inspected.source, source);
  assert.equal(inspected.purpose, "");
  assert.deepEqual(inspected.operations[0].operation, person("$ada", 61, "Ada"));
  assert.deepEqual(inspected.operations[0].evidence, cite("m1"));
  assert.equal(inspected.operations[0].record, null);
  assert.equal(inspected.state, "open");
  // A second call adds to the same batch; its edge names the person staged before.
  await run(f, "StageChanges", { input: { batchId, proposals: [{ operation: person("$bea", 62, "Bea") }, { operation: friends("$friends", 63, 61, 62) }, { operation: person("$cy", 64, "Cy") }] } });
  const selected = (await run(f, "ChangeBatch", { id: batchId, refs: ["$bea"] }, owner)).data.changeBatch;
  assert.deepEqual(selected.operations.map((op: { ref: string }) => op.ref), ["$bea"]);
  assert.deepEqual(selected.counts, { pending: 4 });
  const removed = await run(f, "RemoveStagedChanges", { input: { batchId, refs: ["$cy"] } });
  assert.deepEqual(removed.data?.removeStagedChanges.counts, { pending: 3 });
  const submitted = await run(f, "SubmitBatch", { input: { batchId, summary: "Two people who climb together" } });
  assert.deepEqual([submitted.data?.submitBatch.state, submitted.data?.submitBatch.counts], ["awaiting_review", { awaiting_review: 3 }]);
  // A member batch commits nothing without its member, whatever the confidence.
  assert.equal(await f.exists(uuid(61)), false);
  await json(await f.review({ batchId, verdict: "approve" }));
  const read = await run(f, "ChangeBatch", { id: batchId }, owner);
  assert.equal(read.data?.changeBatch.state, "committed");
  // Committed records come back by handle: node slugs, and an edge as type:from:to.
  assert.deepEqual(read.data?.changeBatch.operations.map((op: { ref: string; record: string }) => [op.ref, op.record]),
    [["$ada", "Person:ada"], ["$bea", "Person:bea"], ["$friends", "test_friends_with(Person:ada → Person:bea)"]]);
  assert.equal((await run(f, "ChangeBatch", { id: uuid(999) }, owner)).data?.changeBatch, null);
});

test("agents name existing records by address, never by UUID", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "people", operations: [person("$ada", 131, "Ada"), person("$bea", 132, "Bea")] }));
  const staged = await run(f, "StageChanges", { input: { title: "Handles", proposals: [
    { operation: { operation: "create", ref: "$gus", type: "graph-node", attributes: { typeId: "Person", title: "Gus" } } },
    { operation: { operation: "create", ref: "$knows", type: "graph-edge", attributes: { typeId: "test_friends_with", fromId: "$gus", toId: "Person:ada" } } },
    { operation: { operation: "create", ref: "$pair", type: "graph-edge", attributes: { typeId: "test_friends_with", fromId: "Person:ada", toId: "Person:bea" } } },
    { operation: { operation: "update", ref: "$ada", type: "graph-node", id: "Person:ada", revision: 1, attributes: { summary: "Climbs on Thursdays." } } },
  ] } });
  assert.equal(staged.errors, undefined, JSON.stringify(staged.errors));
  const batchId = staged.data.stageChanges.id;
  assert.equal((await run(f, "SubmitBatch", { input: { batchId } })).errors, undefined);
  await json(await f.review({ batchId, verdict: "approve" }));
  const read = (await run(f, "ChangeBatch", { id: batchId }, owner)).data.changeBatch;
  assert.deepEqual(read.operations.map((op: { ref: string; record: string }) => [op.ref, op.record]),
    [["$gus", "Person:gus"], ["$knows", "test_friends_with(Person:gus → Person:ada)"], ["$pair", "test_friends_with(Person:ada → Person:bea)"], ["$ada", "Person:ada"]]);
  // An edge is updated by its handle too.
  const archive = await run(f, "StageChanges", { input: { title: "Archive", proposals: [
    { operation: { operation: "update", ref: "$pair", type: "graph-edge", id: "test_friends_with(Person:ada -> Person:bea)", revision: 1, attributes: { archived: true } } },
  ] } });
  assert.equal((await run(f, "SubmitBatch", { input: { batchId: archive.data.stageChanges.id } })).errors, undefined);
  // Unknown handles are refused by name when the batch is submitted.
  const unknown = await run(f, "StageChanges", { input: { title: "Unknown", proposals: [
    { operation: { operation: "create", ref: "$x", type: "graph-edge", attributes: { typeId: "test_friends_with", fromId: "Person:ada", toId: "Person:nobody" } } },
  ] } });
  const refused = await run(f, "SubmitBatch", { input: { batchId: unknown.data.stageChanges.id } });
  assert.match(refused.errors?.[0]?.message ?? "", /Unknown node address, such as Organization:sunny: Person:nobody/);
});

test("documents refuse a read-only member, bad input and a batch that commits by policy", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proposals = [{ operation: person("$di", 71, "Di") }];
  // graph.mutate admits editors and app writers only, as batch.* does.
  assert.equal((await f.action("graph.mutate", { query: documents.StageChanges.document, operationName: "StageChanges", variables: { input: { title: "x", proposals } } },
    { ...owner, role: "member" })).status, 403);
  // Without a batch to add to, a title opens one.
  assert.equal((await run(f, "StageChanges", { input: { proposals } })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  // A batch a member reviews does not use up the Wiki's first discovery run, whatever its source.
  assert.equal((await run(f, "StageChanges", { input: { title: "x", source: { kind: "discovery-run", ref: "run-1" }, proposals } })).errors, undefined);
  const first = await f.action("batch.open", { title: "First", source: { kind: "discovery-run", ref: "run-2" }, policy: { kind: "first-run", version: "test-1" } }, agent);
  assert.equal(first.status, 200);
  assert.equal((await run(f, "SubmitBatch", { input: { batchId: "not-a-batch" } })).errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
  // Forerunner's policy batches commit without a member, so agents cannot stage into or submit them;
  // the app writer that opened one runs the same documents to fill it.
  const policy = { kind: "confidence", threshold: 0.95, version: "test-1" };
  const { batch } = await json(await f.action("batch.open", { title: "Daily", source: { kind: "discovery-run", ref: "run-7" }, policy }, agent));
  const steps = [["StageChanges", { batchId: batch.id, proposals: [{ ...proposals[0], confidence: 1 }] }], ["SubmitBatch", { batchId: batch.id }]] as const;
  for (const [name, input] of steps)
    assert.deepEqual((await run(f, name, { input }, owner)).errors?.[0]?.extensions, { code: "REFUSED", status: 403 });
  // Nor can another app, or an agent holding the member's entity delegation.
  for (const other of [{ ...owner, actor: { kind: "app", id: "other-app" } }, { ...owner, entityWriter: "forerunner", actor: { kind: "oauth-client", id: "claude" } }])
    assert.deepEqual((await run(f, "StageChanges", { input: steps[0][1] }, other)).errors?.[0]?.extensions, { code: "REFUSED", status: 403 });
  // Forerunner, calling as itself with no entity writer as platform dispatch sends it, fills and submits its batch.
  assert.equal((await run(f, "StageChanges", { input: steps[0][1] })).data?.stageChanges.counts.pending, 1);
  // Only an app opens a batch that commits by policy.
  assert.equal((await f.action("batch.open", { title: "Mine", source: { kind: "discovery-run", ref: "run-8" }, policy }, owner)).status, 403);
  // graph.graphql serves no mutations.
  assert.equal((await run(f, "ChangeBatch", { id: batch.id })).data?.changeBatch.state, "open");
  assert.equal((await json(await f.action("graph.graphql", { query: documents.SubmitBatch.document, variables: { input: { batchId: batch.id } } }))).errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
});


test("the Changes sidebar inspects canonical proposals through ChangeBatch without trusting browser content", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proposal = { operation: person("$project", 81, "Proposed project"), evidence: cite("source-81"), confidence: 0.73, reason: "Evidence to discuss." };
  const staged = await run(f, "StageChanges", { input: { title: "Review this discovery", proposals: [proposal] } });
  const id = staged.data.stageChanges.id;
  await run(f, "SubmitBatch", { input: { batchId: id } });
  const ref = { id: uuid(82) };
  const thread = {
    ref, id: ref.id, owner: { kind: "organization", id: "org" }, installationId: "onto-installation",
    createdBy: "owner", visibility: "private", type: "onto.conversation", typeVersion: 1,
    title: "Correct a suggestion", status: "active", context: { type: "onto.page", id: "e9500000-0000-4000-8000-000000000002" },
    parent: null, pinned: false, working: true, readOnly: false, createdAt: 1, updatedAt: 1,
  };
  const workflowHost = { organizationId: "org", installationId: "onto-installation", userId: "owner", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 60_000 };
  const callback = (name: string, body: object) => f.app.call(`/api/internal/threads/v1/${name}`, owner, { method: "POST", body, workflowHost }).then(json);
  const prepare = (location: string) => callback("prepare", { thread, submissionId: uuid(83), retry: false, entry: {
    id: "question", thread: ref, role: "user", parts: [{ type: "text", text: "What does this project suggestion say?" }], status: "complete",
    submissionId: uuid(83), sourceKey: null, attribution: { actor: { kind: "member", id: "owner" }, origin: { kind: "member", id: "owner" }, userId: "owner", installationId: null },
    metadata: { "app.page": { location, state: { batchId: uuid(999), title: "Untrusted browser replacement" } } }, createdAt: 1, recordedAt: null,
  } });
  const prepared = await prepare(`changes/${id}`);
  assert.equal(prepared.context.batch.data.changeBatch.title, "Review this discovery");
  assert.deepEqual(prepared.context.batch.data.changeBatch.operations[0].operation, proposal.operation);
  assert.deepEqual(prepared.context.batch.data.changeBatch.operations[0].evidence, proposal.evidence);
  assert.equal(prepared.context.batch.data.changeBatch.operations[0].confidence, proposal.confidence);
  assert.equal(prepared.context.batch.data.changeBatch.state, "awaiting_review");
  assert.equal(prepared.context.batch.data.changeBatch.operations[0].record, null);
  const tool = prepared.tools.find((item: { name: string }) => item.name === "onto_batch_inspect");
  assert.equal(tool.store, false);
  const inspected = await callback("tool", { thread, submissionId: uuid(83), call: { id: "inspect", name: tool.name, input: { id } } });
  assert.deepEqual(inspected.output, prepared.context.batch);
  assert.equal((await prepare(`changes/${uuid(999)}`)).context.batch.data.changeBatch, null);
  assert.equal(await f.exists(uuid(81)), false);
});

test("plural change documents append durably, submit explicitly, and preserve the human review gate",async t=>{
  const f=await fixture();t.after(()=>f.app.dispose());
  const call=async(document:string,input:object,identity:object=agent)=>json(await f.action("graph.mutate",{query:print(documents.ChangeBatchChanges.document),operationName:document,variables:{input}},identity));
  const send=async(items:object[],identity:object=agent)=>(await call("ChangeBatchChanges",{items},identity)).data.changeBatchChanges;
  const first=await send([{key:uuid(900),action:"stage",input:{title:"Batch contract",proposals:[{operation:person("$first",901,"First"),evidence:cite("first")}]}}]);
  const id=first.items[0].result.id;
  assert.equal(first.items[0].result.reviewUrl, batchReviewUrl(id));
  const expectedReviewUrl = `changes/${first.items[0].result.id}`;
  assert.equal(first.items[0].status,"pending");assert.equal(first.instructions[0].code,"SUBMIT_CHANGES");
  assert.equal(first.instructions[0].url, expectedReviewUrl);
  const listed = await json(await f.action("graph.graphql", { query: documents.ChangeBatches.document, variables: { first: 100 } }));
  assert.equal(listed.data.changeBatches.nodes.find((batch: { id: string }) => batch.id === first.items[0].result.id).reviewUrl, expectedReviewUrl);
  const append={key:uuid(902),action:"stage",input:{batchId:id,proposals:[{operation:person("$second",903,"Second"),evidence:cite("second")}]}};
  await send([append]);await send([append]);
  const submitted=await send([{key:uuid(904),action:"submit",input:{batchId:id}}]);
  assert.equal(submitted.items[0].result.counts.awaiting_review,2);
  assert.equal(submitted.instructions[0].actor,"human");
  assert.equal(submitted.instructions[0].url, expectedReviewUrl);
  assert.equal(await f.exists(uuid(901)),false);
  const personalIdentity = { ...agent, owner: { kind: "user" as const, id: "personal-owner" } };
  const personalStage = await send([{ key: uuid(907), action: "stage", input: { title: "Personal batch", proposals: [{ operation: person("$personal", 908, "Personal"), evidence: cite("personal") }] } }], personalIdentity);
  const personalId = personalStage.items[0].result.id;
  const personalUrl = `changes/${personalId}`;
  assert.equal(personalStage.items[0].result.reviewUrl, personalUrl);
  assert.equal(personalStage.instructions[0].url, personalUrl);
  const denied=await send([{key:uuid(905),action:"review",input:{batchId:id,verdict:"approve"}}]);
  assert.notEqual(denied.items[0].status,"complete");
  const approved=await send([{key:uuid(906),action:"review",input:{batchId:id,verdict:"approve"}}],owner);
  assert.equal(approved.items[0].result.state,"committed");assert.deepEqual(approved.instructions,[]);
  assert.equal(await f.exists(uuid(901)),true);
});

test("a member's own agent connection reviews a batch with the member's identity; apps, delegated writers and residents cannot", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const connection = { ...owner, actor: { kind: "oauth-client" as const, id: "claude-desktop", label: "Claude" } };
  const changes = async (items: object[], identity: object) =>
    (await json(await f.action("graph.mutate", { query: print(documents.ChangeBatchChanges.document), operationName: "ChangeBatchChanges", variables: { input: { items } } }, identity))).data.changeBatchChanges;
  const staged = await changes([{ key: uuid(920), action: "stage", input: { title: "Over MCP", proposals: [{ operation: person("$fay", 121, "Fay"), evidence: cite("fay") }] } }], connection);
  const id = staged.items[0].result.id;
  await changes([{ key: uuid(921), action: "submit", input: { batchId: id } }], connection);
  let key = 922;
  const refused = async (identity: object) => {
    const result = await changes([{ key: uuid(key++), action: "review", input: { batchId: id, verdict: "approve" } }], identity);
    assert.notEqual(result.items[0].status, "complete", JSON.stringify(identity));
    assert.equal(await f.exists(uuid(121)), false, JSON.stringify(identity));
  };
  await refused(agent);
  await refused({ ...connection, entityWriter: "forerunner" });
  await refused({ ...connection, userId: "resident:identity-installation:pi" });
  // graph.mutate itself turns away a connection bound to a read-only member.
  assert.equal((await f.action("graph.mutate", { query: print(documents.ChangeBatchChanges.document), operationName: "ChangeBatchChanges",
    variables: { input: { items: [{ key: uuid(key++), action: "review", input: { batchId: id, verdict: "approve" } }] } } }, { ...connection, role: "member" })).status, 403);
  const approved = await changes([{ key: uuid(key++), action: "review", input: { batchId: id, verdict: "approve", comment: "Looks right" } }], connection);
  assert.equal(approved.items[0].result.state, "committed");
  assert.equal(await f.exists(uuid(121)), true);
  // The decision names the member and the connection it came through.
  const { operations } = await json(await f.action("batch.get", { batchId: id }));
  assert.deepEqual({ ...operations[0].decision, at: 0 }, { kind: "member", by: "owner", via: "oauth-client:claude-desktop", viaLabel: "Claude", verdict: "approve", comment: "Looks right", at: 0 });
});

test("agents repair one draft by ref and get anchor and ontology validation in mutation results", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "anchor-person", operations: [person("$anchor", 950, "Anchor")] }));
  const send = async (action: string, input: object, identity: object = agent) => {
    const result = await json(await f.action("graph.mutate", { query: print(documents.ChangeBatchChanges.document), operationName: "ChangeBatchChanges", variables: { input: { items: [{ key: crypto.randomUUID(), action, input }] } } }, identity));
    assert.equal(result.errors, undefined);
    if (result.data.changeBatchChanges.items[0].result?.validation?.valid === false) assert.equal(result.data.changeBatchChanges.instructions[0].code, "REPAIR_CHANGES");
    return result.data.changeBatchChanges.items[0];
  };
  const first = await send("stage", { title: "Repair me", anchors: [uuid(950)], proposals: [{ operation: person("$child", 951, "Child") }] });
  const batchId = first.result.id;
  assert.equal(first.result.validation.valid, false);
  assert.match(first.result.validation.error, /anchor/);
  assert.equal(first.result.anchors[0], "Person:anchor");
  const invalid = await send("stage", { batchId, replace: true, proposals: [{ operation: create("$child", "graph-node", { id: uuid(951), typeId: "MissingType", title: "Child" }) }] });
  assert.equal(invalid.result.validation.valid, false);
  const fixed = await send("stage", { batchId, replace: true, proposals: [{ operation: person("$child", 951, "Corrected"), evidence: cite("correction"), reason: "Corrected source" }, { operation: create("$link", "graph-edge", { id: uuid(952), typeId: ids.friend, fromId: uuid(950), toId: "$child" }) }] });
  assert.equal(fixed.result.validation.valid, true);
  assert.equal(fixed.result.counts.pending, 2);
  assert.equal(await f.exists(uuid(951)), false);
  const detail = (await run(f, "ChangeBatch", { id: batchId })).data.changeBatch;
  assert.equal(detail.operations.find((op: {ref:string}) => op.ref === "$child").reason, "Corrected source");
  const cleared = await send("configure", { batchId, anchors: [] });
  assert.deepEqual(cleared.result.anchors, []);
  assert.equal(cleared.result.validation.valid, true);
  const viewer = { ...owner, role: "viewer" };
  const readOnly = await json(await f.app.call(`/api/apps/onto/batches/get?id=${batchId}`, viewer));
  assert.equal(readOnly.validation.valid, true);
  assert.equal(readOnly.canReview, false);
  assert.equal((await f.app.call("/api/apps/onto/batches/configure", viewer, { method: "POST", body: { batchId, anchors: [] } })).status, 403);
  await send("submit", { batchId });
  const frozen = await send("stage", { batchId, replace: true, proposals: [{ operation: person("$child", 951, "Too late") }] });
  assert.equal(frozen.result, null);
  assert.equal(await f.exists(uuid(951)), false);
});

test("member amendments replace and add proposals without committing; invalid or decided changes are refused", async (t) => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const connection = { ...owner, actor: { kind: "oauth-client", id: "member-mcp" } };
  const staged = await run(f, "StageChanges", { input: { title: "Prototype", proposals: [
    { operation: person("$ada", 201, "Ada") }, { operation: person("$bea", 202, "Bea") },
    { operation: friends("$friends", 203, 201, 202) },
  ] } });
  const batchId = staged.data.stageChanges.id;
  await run(f, "SubmitBatch", { input: { batchId } });
  const before = await json(await f.action("batch.get", { batchId }));
  const beforeStored = await f.app.database.prepare("SELECT reviewJobId FROM graph_batches WHERE id=?").bind(batchId).first();
  const amendment = { batchId, proposals: [
    { operation: person("$ada", 201, "Ada revised"), evidence: cite("revised-source") },
    { operation: person("$cy", 204, "Cy") },
  ] };
  const revised = await run(f, "ReviseBatch", { input: amendment }, connection);
  assert.equal(revised.errors, undefined);
  assert.equal(revised.data.reviseBatch.reviewUrl, batchReviewUrl(batchId));
  assert.deepEqual([revised.data.reviseBatch.state, revised.data.reviseBatch.counts], ["awaiting_review", { awaiting_review: 4 }]);
  const after = await json(await f.action("batch.get", { batchId }));
  assert.deepEqual(after.batch.policy, before.batch.policy); assert.equal(after.batch.reviewBy, before.batch.reviewBy);
  const afterStored = await f.app.database.prepare("SELECT commits,reviewJobId FROM graph_batches WHERE id=?").bind(batchId).first();
  assert.equal(afterStored?.commits, 0); assert.notEqual(afterStored?.reviewJobId, beforeStored?.reviewJobId);
  assert.equal(after.batch.summary.operations, 4);
  assert.equal(after.operations[0].operation.attributes.title, "Ada revised");
  assert.equal(after.operations[0].position, before.operations[0].position);
  assert.equal(await f.exists(uuid(201)), false); assert.equal(await f.exists(uuid(204)), false);
  const invalid = await run(f, "ReviseBatch", { input: { batchId, remove: ["$bea"] } }, connection);
  assert.equal(invalid.errors[0].extensions.status, 409);
  assert.equal((await json(await f.action("batch.get", { batchId }))).operations.length, 4);
  for (const identity of [agent, { ...connection, role: "member" }, { ...owner, entityWriter: { installationId: "delegator" } }]) {
    const denied = await f.action("graph.mutate", { query: documents.ReviseBatch.document, operationName: "ReviseBatch", variables: { input: amendment } }, identity);
    if (denied.status === 200) assert.equal((await denied.json() as any).errors[0].extensions.status, 403);
    else assert.equal(denied.status, 403);
  }
  await json(await f.review({ batchId, refs: ["$ada"], verdict: "approve" }));
  const decided = await run(f, "ReviseBatch", { input: amendment }, connection);
  assert.equal(decided.errors[0].extensions.status, 409);
  const amended = await run(f, "ChangeBatchChanges", { input: { items: [{ key: uuid(205), action: "amend", input: { batchId, remove: ["$friends"] } }] } }, connection);
  assert.equal(amended.errors, undefined);
  assert.equal(amended.data.changeBatchChanges.items[0].result.state, "awaiting_review");
  assert.equal(await f.exists(uuid(204)), false);
});

test("amendment snapshot refuses a decision arriving during validation", async (t) => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const staged = await run(f, "StageChanges", { input: { title: "Concurrent review", proposals: [{ operation: person("$ada", 211, "Ada") }] } });
  const batchId = staged.data.stageChanges.id; await run(f, "SubmitBatch", { input: { batchId } });
  const client = f.app.database, original = client.batch.bind(client);
  let injected = false;
  const proxy = new Proxy(client, { get(target, key) {
    if (key === "batch") return async (statements: any[]) => {
      if (!injected) { injected = true; await client.prepare("UPDATE graph_batch_operations SET state='rejected' WHERE batchId=? AND ref='$ada'").bind(batchId).run(); }
      return original(statements);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const { reviseBatch, batchReviseInput } = await import("../src/server/graph-batches");
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  await assert.rejects(reviseBatch(drizzle(proxy), who, { kind: "member", id: "owner" }, { kind: "member", id: "owner" }, batchReviseInput.parse({ batchId, proposals: [{ operation: person("$ada", 211, "Stale edit") }] })), (error: any) => error instanceof Response && error.status === 409);
  const after = await json(await f.action("batch.get", { batchId }));
  assert.equal(after.operations[0].state, "rejected"); assert.equal(after.operations[0].operation.attributes.title, "Ada");
  assert.equal(await f.exists(uuid(211)), false);
});

test("a review cannot approve stale proposals after an amendment commits", async (t) => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const staged = await run(f, "StageChanges", { input: { title: "Stale approval", proposals: [{ operation: person("$ada", 221, "Ada") }] } });
  const batchId = staged.data.stageChanges.id; await run(f, "SubmitBatch", { input: { batchId } });
  const client = f.app.database, original = client.batch.bind(client);
  let injected = false;
  const proxy = new Proxy(client, { get(target, key) {
    if (key === "batch") return async (statements: any[]) => {
      if (!injected) {
        injected = true;
        await client.prepare("UPDATE graph_batch_operations SET operation=json_set(operation,'$.attributes.title','Changed after review began') WHERE batchId=?").bind(batchId).run();
        await client.prepare("UPDATE graph_batches SET reviewJobId='new-amendment-job' WHERE id=?").bind(batchId).run();
      }
      return original(statements);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const { reviewBatch } = await import("../src/server/graph-batches");
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  await assert.rejects(reviewBatch(drizzle(proxy), who, { kind: "member", id: "owner" }, { kind: "member", id: "owner" }, { batchId, verdict: "approve" }), (error: any) => error instanceof Response && error.status === 409);
  assert.equal(await f.exists(uuid(221)), false);
  const after = await json(await f.action("batch.get", { batchId }));
  assert.equal((await client.prepare("SELECT commits FROM graph_batches WHERE id=?").bind(batchId).first())?.commits, 0); assert.equal(after.operations[0].state, "awaiting_review");
  assert.equal(after.operations[0].operation.attributes.title, "Changed after review began");
});

test("amendment anchor checks use the projected graph after a saved edge is archived", async (t) => {
  const f = await fixture(); t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "anchor-base", operations: [person("$anchor", 231, "Anchor"), person("$bridge", 232, "Bridge"), friends("$path", 233, 231, 232)] }));
  const staged = await run(f, "StageChanges", { input: { title: "Anchored child", anchors: ["Person:anchor"], proposals: [
    { operation: person("$child", 234, "Child") }, { operation: friends("$child-path", 235, 232, 234) },
  ] } });
  const batchId = staged.data.stageChanges.id;
  const submitted = await run(f, "SubmitBatch", { input: { batchId } });
  assert.equal(submitted.errors, undefined);
  const amended = await run(f, "ReviseBatch", { input: { batchId, proposals: [{ operation: { operation: "update", ref: "$archive-path", type: "graph-edge", id: "test_friends_with(Person:anchor → Person:bridge)", revision: 1, attributes: { archived: true } } }] } }, owner);
  assert.equal(amended.errors[0].extensions.status, 409);
  assert.match(amended.errors[0].message, /anchor/i);
  assert.equal((await json(await f.action("batch.get", { batchId }))).operations.length, 2);
  assert.equal(await f.exists(uuid(234)), false);
});

test("a member-reviewed batch anchors to the organization's root unless it names its own anchors", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  await json(await f.action("graph.apply", { requestKey: "root", operations: [
    create("$org", "graph-node", { id: uuid(960), typeId: core.organization, title: "Acme", slug: "acme", properties: { organization_id: "org" } }),
    person("$known", 961, "Known"),
  ] }));
  const stage = async (input: object) => (await run(f, "StageChanges", { input }, agent)).data.stageChanges;
  const loose = await stage({ title: "Loose", proposals: [{ operation: person("$loose", 962, "Loose") }] });
  assert.deepEqual(loose.anchors, ["Organization:acme"]);
  assert.match(loose.validation.error, /anchor/);
  // Named anchors replace the root; an empty list asks for none.
  assert.deepEqual((await stage({ title: "Narrow", anchors: ["Person:known"], proposals: [{ operation: person("$other", 963, "Other") }] })).anchors, ["Person:known"]);
  const free = await stage({ title: "Free", anchors: [], proposals: [{ operation: person("$free", 964, "Free") }] });
  assert.deepEqual(free.anchors, []);
  assert.equal(free.validation.valid, true);
  // A scheduled app batch anchors to the root too: what is confident and traceable commits,
  // what reaches no anchor waits for a member with what depends on it.
  const { batch } = await json(await f.action("batch.open", { title: "Discovery", source: { kind: "discovery-run", ref: "run-root" }, policy: { kind: "confidence", threshold: 0.95, version: "test-1" } }, agent));
  assert.deepEqual(batch.anchors, [uuid(960)]);
  const narrow = (await json(await f.action("batch.open", { title: "Discovery", anchors: ["Person:known"], source: { kind: "discovery-run", ref: "run-root" }, policy: { kind: "confidence", threshold: 0.95, version: "test-1" } }, agent))).batch;
  await json(await f.action("batch.add", { batchId: narrow.id, proposals: [
    { operation: person("$linked", 965, "Linked"), evidence: cite("r1"), confidence: 0.99 },
    { operation: friends("$link", 966, 965, 961), evidence: cite("r1"), confidence: 0.99 },
    { operation: person("$stray", 967, "Stray"), evidence: cite("r2"), confidence: 0.99 },
    { operation: person("$strayer", 968, "Strayer"), evidence: cite("r2"), confidence: 0.99 },
    { operation: friends("$strays", 970, 967, 968), evidence: cite("r2"), confidence: 0.99 },
  ] }, agent));
  const submitted = await json(await f.action("batch.submit", { batchId: narrow.id }, agent));
  assert.equal(submitted.batch.state, "awaiting_review");
  assert.equal(await f.exists(uuid(965)), true);
  assert.equal(await f.exists(uuid(967)), false);
  assert.equal(submitted.counts.awaiting_review, 3);
});

test("a personal Onto anchors a new batch to its owner's Person", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const me = { userId: "owner", organizationId: "", role: "owner", owner: { kind: "user", id: "owner" } };
  const ada = await json(await f.app.call("/api/internal/entities/v1/create", me as typeof owner, { method: "POST", body: { type: "graph-node", attributes: { typeId: core.person, title: "Ada", slug: "ada" } } }));
  await json(await f.app.call("/api/internal/identity/v1/link", me as typeof owner, { method: "POST", body: { holderId: ada.ref.id, principalId: "owner", kind: "human" } }));
  const staged = (await run(f, "StageChanges", { input: { title: "Mine", proposals: [{ operation: person("$friend", 970, "Friend") }] } }, me)).data.stageChanges;
  assert.deepEqual(staged.anchors, ["Person:ada"]);
  assert.match(staged.validation.error, /anchor/);
});
