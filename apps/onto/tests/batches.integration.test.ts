import { print } from "graphql";
import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { drizzle } from "drizzle-orm/d1";
import { documents } from "../src/server/documents";
import { sealDueBatches } from "../src/server/graph-batches";
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
  f.action(name === "ChangeBatch" ? "graph.graphql" : "graph.mutate", { query: documents[name].document, operationName: name, variables }, identity).then(json);

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
  assert.equal(first.items[0].status,"pending");assert.equal(first.instructions[0].code,"SUBMIT_CHANGES");
  const append={key:uuid(902),action:"stage",input:{batchId:id,proposals:[{operation:person("$second",903,"Second"),evidence:cite("second")}]}};
  await send([append]);await send([append]);
  const submitted=await send([{key:uuid(904),action:"submit",input:{batchId:id}}]);
  assert.equal(submitted.items[0].result.counts.awaiting_review,2);
  assert.equal(submitted.instructions[0].actor,"human");
  assert.equal(await f.exists(uuid(901)),false);
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
