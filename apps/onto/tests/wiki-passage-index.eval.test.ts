import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AppArchive } from "@ai-outfitter/app-sdk/data-transfer";
import type { AppDocumentRow } from "@ai-outfitter/app-sdk/app-documents";
import { wikiPassage } from "@ai-outfitter/app-sdk/graph-contracts";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-graphql";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { actionsPath, createWikiCorpus, json, phrases, sourceSlug, sourceText, sourceTitle } from "./fixtures/wiki-passage-corpus";
import { createOntoHarness, indexWorkflow } from "./fixtures/wiki-passage-host";

const alpha = { userId: "eval-alpha-owner", organizationId: "eval-alpha", role: "owner" };
const beta = { userId: "eval-beta-owner", organizationId: "eval-beta", role: "owner" };
const alphaWiki = { wikiInstallationId: "wiki-eval-alpha" };
const betaWiki = { wikiInstallationId: "wiki-eval-beta" };

const id = (n: number) => `f0268000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sensor = "EvalInstrument:copper-sensor";
const recorder = "EvalInstrument:amber-recorder";
const relay = "EvalInstrument:cinnabar-relay";
const spectrometer = "EvalInstrument:vermilion-spectrometer";
const foreign = "EvalInstrument:obsidian-sextant";
const initialBody = "Synthetic starting description.";
const positiveBody = "Copper Sensor records the cyclamen pendulum baseline.";
const create = (ref: string, type: string, attributes: object) => ({
  operation: "create", ref, type, attributes,
});
const node = (n: number, slug: string, title: string) => create(`$${slug}`, "graph-node", {
  id: id(n), typeId: id(1), slug, title, body: initialBody,
});
function graphDefinitions() {
  return [
    create("$instrument", "graph-type", {
      id: id(1), name: "EvalInstrument", title: "Eval Instrument", category: "node", body: "Synthetic instrument type.",
    }),
    create("$connection", "graph-type", {
      id: id(2), name: "eval_connected_to", title: "Eval connected to", category: "edge", body: "Synthetic instrument connection.",
      ontology: { version: 2, endpoints: { from: [id(1)], to: [id(1)] } },
    }),
  ];
}
const updateSensor = {
  operation: "update", ref: "$sensor-update", type: "graph-node", id: sensor, revision: 1,
  attributes: { body: positiveBody },
};

type Locator =
  | { kind: "wiki-page"; section: string; start: number; end: number }
  | { kind: "pdf-page"; page: number; start: number; end: number }
  | { kind: "transcript"; startMs: number; endMs: number; start: number; end: number };
type Source = {
  installationId: string; organizationId: string; sourceId: string; pageSlug: string; pageId: string;
  revision: number; pageRevision: number; documentId: string; version: string; sha256: string | null; contentHash: string;
};
type Passage = { id: string; text: string; source: Source; locator: Locator };
type Batch = { id: string; state: string; anchors?: string[]; review?: { state: string; runId: string; decision?: { approved: number; held: unknown[] } } | null };
type ReviewedOperation = {
  state: string; evidence: Array<{ provider: string; quote: string; recordId: string; version: string; contentHash: string }>;
  recordId: string | null;
};
type Progress = { cursor: string | null; updatedAt: number | null; sweeps: number; indexedSources: number; indexedPassages: number; pendingSources: number; pendingPassages: number; pendingSuggestions: number; routed: number; unresolved: number; lastError: string | null };
type Harness = Awaited<ReturnType<typeof createOntoHarness>>;
const connected = (member: Member): Member => ({ ...member, actor: { kind: "oauth-client", id: "eval-mcp-client" } });
const published = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8")) as AppDocumentRow[];
const passageDocuments = {
  search: publishedPassageDocument("WikiPassageSearch", "query"),
  status: publishedPassageDocument("WikiPassageStatus", "query"),
  enable: publishedPassageDocument("EnableWikiPassageIndex", "mutation"),
};

function publishedPassageDocument(name: string, kind: AppDocumentRow["kind"]) {
  const doc = published.find(row => row.name === name);
  assert.ok(doc?.mcp?.description && !doc.hidden, `${name} is published to MCP`);
  assert.equal(doc.kind, kind);
  assert.ok(doc.outputSchema);
  return doc;
}

type PassageVariables = typeof alphaWiki & { query?: string; limit?: number; after?: string };
function documentInput(doc: AppDocumentRow, { wikiInstallationId, ...variables }: PassageVariables) {
  return { query: doc.query, operationName: doc.name, variables: { ...variables, wiki: { installationId: wikiInstallationId } } };
}

function documentCall(harness: Harness, doc: AppDocumentRow, variables: PassageVariables, member?: Member) {
  return harness.action(doc.kind === "query" ? "graph.graphql" : "graph.mutate", documentInput(doc, variables),
    member, doc.kind === "query" ? "read" : undefined);
}

async function allowedDocument<T>(response: Response) {
  const result = graphGraphqlResult.parse(await json(response));
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.ok(result.data);
  return result.data as T;
}

async function refusedDocument(response: Response, status: number) {
  const result = graphGraphqlResult.parse(await json(response));
  assert.equal(result.data, null);
  assert.ok(result.errors?.length);
  for (const error of result.errors) {
    assert.equal(error.extensions?.code, "REFUSED", JSON.stringify(error));
    assert.equal(error.extensions?.status, status);
  }
}

function proposal(anchors: string[], quote: string, operation: object, reason: string) {
  return { anchors, quote, operation, reason };
}

function inference(data: unknown) {
  const text = JSON.stringify(data);
  const suggestions = [];
  if (text.includes(phrases.wiki)) {
    suggestions.push(proposal([sensor], sourceText.wiki, updateSensor, "single local anchor"));
    suggestions.push(proposal([sensor], phrases.wiki, updateSensor, "anchor occurs outside the proposed quote"));
    suggestions.push(proposal([sensor, foreign], phrases.wiki, updateSensor, "foreign anchor mixed with a local anchor"));
  }
  if (text.includes(phrases.pdf)) {
    suggestions.push({
      anchors: [sensor, recorder, relay], quote: sourceText.pdf, reason: "three local anchors in one review",
      operations: [
        create("$sensor-to-recorder", "graph-edge", { typeId: "eval_connected_to", fromId: sensor, toId: recorder }),
        create("$sensor-to-relay", "graph-edge", { typeId: "eval_connected_to", fromId: sensor, toId: relay }),
        create("$spectrometer", "graph-node", { typeId: "EvalInstrument", title: "Vermilion Spectrometer" }),
        create("$relay-to-spectrometer", "graph-edge", { typeId: "eval_connected_to", fromId: relay, toId: "$spectrometer" }),
      ],
    });
    suggestions.push(proposal(["EvalInstrument:never-seeded"], phrases.pdf, updateSensor, "missing anchor"));
  }
  if (text.includes(phrases.transcript)) {
    suggestions.push(proposal([recorder], phrases.transcript, { ...updateSensor, id: recorder }, "unmentioned local anchor"));
    suggestions.push(proposal([recorder], "Invented excerpt", {
      ...updateSensor, id: recorder, attributes: { body: "A different unsupported update." },
    }, "fabricated quote"));
    suggestions.push(proposal(["Shared Receiver"], sourceText.transcript, updateSensor, "ambiguous title"));
  }
  return { suggestions };
}

function note(scenario: string, status: string, expected: string, actual: unknown) {
  const line = JSON.stringify({ issue: 268, scenario, status, expected, actual });
  if (process.env.WIKI_PASSAGE_EVIDENCE) appendFileSync(process.env.WIKI_PASSAGE_EVIDENCE, line + "\n");
}
async function check<T>(scenario: string, expected: string, run: () => Promise<T>): Promise<T> {
  try {
    const actual = await run();
    note(scenario, "pass", expected, actual);
    return actual;
  } catch (error) {
    note(scenario, "fail", expected, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
const search = async (harness: Harness, scope: typeof alphaWiki, query: string, member?: typeof alpha) =>
  (await harness.read<{ passages: Passage[] }>("passage.search", { ...scope, query }, member)).passages;

async function graphQuery<T>(harness: Harness, query: string, variables: object = {}) {
  const result = await harness.read<{ data: T; errors?: unknown }>("graph.graphql", { query, variables });
  assert.equal(result.errors, undefined);
  return result.data;
}
const batches = async (harness: Harness) =>
  (await graphQuery<{ changeBatches: { nodes: Batch[] } }>(harness, "{ changeBatches { nodes { id state } } }")).changeBatches.nodes;
const graphState = (harness: Harness) => graphQuery<{
  node: { body: string; revision: number; edges: { totalCount: number } };
}>(harness, `{ node(id: "${sensor}") { body revision edges(types: ["eval_connected_to"]) { totalCount } } }`);
const batchDetails = (harness: Harness, batchId: string) =>
  harness.read<{ batch: Batch; operations: ReviewedOperation[] }>("batch.get", { batchId });

async function denied(response: Response) {
  assert.ok([403, 404].includes(response.status), `${response.status} ${await response.text()}`);
  return response.status;
}

test("issue #268 synthetic source indexing and member review through installed workers", { timeout: 180_000 }, async t => {
  const corpus = await createWikiCorpus(alpha, alphaWiki.wikiInstallationId);
  t.after(() => corpus.wiki.dispose());
  const foreignCorpus = await createWikiCorpus(beta, betaWiki.wikiInstallationId);
  t.after(() => foreignCorpus.wiki.dispose());
  const fixture = await check("verified-source-fixtures", "First Wiki revision and two verified file hashes. The second organization has independent bytes", async () => {
    const page = await corpus.publish(await corpus.save(sourceText.wiki));
    await corpus.save("Unpublished cerulean draft", undefined, "unpublished-cerulean-draft");
    const pdf = await corpus.attachPdf();
    const transcript = await corpus.attachTranscript();
    const foreignPage = await foreignCorpus.publish(await foreignCorpus.save(sourceText.foreign));
    assert.equal(page.revision, 1);
    assert.notEqual(page.id, foreignPage.id);
    return { page, pdf, transcript, foreignPage };
  });
  await check("oversized-extraction", "A supported attachment whose 10,000 transcript cues expand beyond the passage limit returns a pinned issue without retry", async () => {
    const oversized = await createWikiCorpus(alpha, "wiki-eval-oversized");
    t.after(() => oversized.wiki.dispose());
    await oversized.publish(await oversized.save("Oversized transcript fixture."));
    const timed = "00:00:04.000 --> 00:00:08.000";
    const bytes = Buffer.from(`WEBVTT\n\n${timed}\n${"a".repeat(1201)}\n\n${`${timed}\nx\n\n`.repeat(9999)}`);
    const receipt = await oversized.upload("oversized.vtt", "text/vtt", bytes);
    const call = async (action: string, input: object) => json(await oversized.wiki.call(actionsPath, oversized.reader, {
      method: "POST", body: { action, input },
    }));
    const inventory = wikiPassage.sourceInventory.parse(await call("passage.sources", { limit: 1 }));
    const [source] = inventory.sources;
    assert.ok(source);
    assert.equal(source.sha256, receipt.sha256);
    assert.equal(inventory.next, source.sourceId);
    const next = wikiPassage.sourceInventory.parse(await call("passage.sources", { limit: 1, after: inventory.next }));
    assert.equal(next.sources.length, 1);
    assert.match(next.sources[0].sourceId, /^page:/);
    assert.equal(next.next, null);
    const result = wikiPassage.sourceRead.parse(await call("passage.read", { sourceId: source.sourceId, version: source.version }));
    assert.equal(result.state, "active");
    assert.equal(result.source.contentHash, receipt.sha256);
    assert.deepEqual(result.passages, []);
    assert.equal(result.issue, "Source exceeds the passage indexing limit");
    return { version: source.version, digest: result.source.contentHash, passageCount: result.passages.length, issue: result.issue };
  });
  const onto = await createOntoHarness(alpha, corpus, inference);
  t.after(() => onto.app.dispose());
  const other = await createOntoHarness(beta, foreignCorpus, data => {
    assert.ok(!JSON.stringify(data).includes(phrases.wiki), "foreign text reached Beta's inference");
    return { suggestions: [] };
  });
  t.after(() => other.app.dispose());

  await onto.read("graph.apply", { requestKey: "eval-local-anchors", operations: [
    ...graphDefinitions(), node(3, "copper-sensor", "Copper Sensor"), node(4, "amber-recorder", "Amber Recorder"),
    node(5, "shared-receiver-a", "Shared Receiver"), node(6, "shared-receiver-b", "Shared Receiver"),
    node(8, "cinnabar-relay", "Cinnabar Relay"),
  ] });
  await other.read("graph.apply", { requestKey: "eval-foreign-anchor", operations: [
    ...graphDefinitions(), node(7, "obsidian-sextant", "Obsidian Sextant"),
  ] });
  await json(await onto.app.call("/api/apps/onto/settings", alpha, {
    method: "POST", body: { stewardApproval: "approve" },
  }));
  assert.deepEqual(await graphState(onto), {
    node: { body: initialBody, revision: 1, edges: { totalCount: 0 } },
  });
  await check("schedule-authorization", "Member and foreign Wiki denied. The owner saves the registered schedule. Untrusted dispatch is denied", async () => {
    const member = await denied(await onto.action("passage.schedule", alphaWiki, corpus.reader));
    const wrongOrg = await denied(await onto.action("passage.schedule", betaWiki));
    const before = await allowedDocument<{ wikiPassageProgress: Progress; wikiPassageHeldItems: object }>(
      await documentCall(onto, passageDocuments.status, alphaWiki, corpus.reader));
    assert.equal(before.wikiPassageProgress.indexedPassages, 0);
    assert.equal(before.wikiPassageProgress.updatedAt, null);
    assert.deepEqual(before.wikiPassageHeldItems, { sources: [], suggestions: [] });
    assert.equal(onto.schedules.size, 0);
    assert.ok(onto.calls.every(call => call.operation !== "schedule.save"));

    assert.equal(await denied(await documentCall(onto, passageDocuments.enable, alphaWiki, corpus.reader)), 403);
    const delegated = { ...corpus.reader, entityWriter: "eval-delegated-writer" };
    await refusedDocument(await documentCall(onto, passageDocuments.enable, alphaWiki, delegated), 403);
    await refusedDocument(await documentCall(onto, passageDocuments.enable, betaWiki), 404);
    const enableInput = documentInput(passageDocuments.enable, alphaWiki);
    const mutationOnRead = graphGraphqlResult.parse(await json(await onto.action("graph.graphql", enableInput, alpha, "read")));
    assert.equal(mutationOnRead.errors?.[0]?.extensions?.code, "OPERATION_NOT_ALLOWED");
    const queryOnMutation = graphGraphqlResult.parse(await json(await onto.action("graph.mutate", documentInput(passageDocuments.status, alphaWiki))));
    assert.equal(queryOnMutation.errors?.[0]?.extensions?.code, "OPERATION_NOT_ALLOWED");
    assert.equal(await denied(await onto.action("graph.mutate", enableInput, alpha, "read")), 403);
    assert.equal(onto.schedules.size, 0);
    const receipt = await allowedDocument<{ enableWikiPassageIndex: {
      id: string; workflowId: string; enabled: boolean; cron: string; timezone: string; nextRunAt: number;
    } }>(await documentCall(onto, passageDocuments.enable, alphaWiki, connected(alpha)));
    await other.read("passage.schedule", betaWiki);
    const schedule = onto.schedules.get(indexWorkflow);
    assert.deepEqual(schedule?.inputs, alphaWiki);
    assert.deepEqual(receipt.enableWikiPassageIndex, {
      id: schedule?.id, workflowId: indexWorkflow, enabled: true,
      cron: "0 */6 * * *", timezone: "UTC", nextRunAt: schedule?.nextRunAt,
    });
    assert.equal(onto.calls.filter(call => call.operation === "schedule.save").length, 1);
    assert.ok(onto.calls.every(call => call.operation !== "workflow.start"));
    const untrusted = await onto.occurrence(indexWorkflow, { trusted: false });
    assert.equal(untrusted.status, 503, await untrusted.text());
    const refused = await json<{ outcome: string }>(await onto.occurrence(indexWorkflow, { member: corpus.reader }));
    assert.equal(refused.outcome, "declined");
    return { member, wrongOrg, receipt, schedule, untrusted: untrusted.status, refused };
  });

  const progress = () => onto.read<Progress>("passage.progress", alphaWiki);
  const collectProgress = () => onto.calls.filter(call =>
    call.operation === "workflow.collect" && call.input.slot === "index.outputs.progress");
  await check("transport-retry", "One injected inventory 503 is observable and a subsequent occurrence can recover", async () => {
    const before = await progress();
    onto.failNextInventory();
    const failed = await onto.occurrence();
    assert.ok(onto.calls.some(call => call.input.action === "passage.sources" && call.status === 503));
    assert.equal(failed.status, 503);
    const after = await progress();
    assert.equal(after.sweeps, before.sweeps);
    assert.equal(after.indexedSources, 0);
    assert.match(after.lastError ?? "", /503/);
    return { before, status: failed.status, response: await failed.text(), after };
  });

  async function advance(harness: Harness, ready: () => Promise<boolean>) {
    const outcomes: unknown[] = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      const outcome = await json<{ outcome: string }>(await harness.occurrence());
      outcomes.push(outcome);
      if (await ready()) return outcomes;
    }
    const wiki = { wikiInstallationId: harness === onto ? alphaWiki.wikiInstallationId : betaWiki.wikiInstallationId };
    const state = await harness.read("passage.progress", wiki);
    const unresolved = await harness.read("passage.unresolved", wiki);
    const extraction = harness.calls.filter(call => call.input.action === "passage.read");
    assert.fail(`Index did not catch up: ${JSON.stringify({ outcomes, state, unresolved, extraction })}`);
  }
  const citations = await check("unlinked-discovery-and-exact-citations",
    "Member discovers Wiki body, PDF page 2 and WebVTT cue 133500–139750 ms with correct source revision and file hashes", async () => {
      const outcomes = await advance(onto, async () => (await Promise.all(
        [phrases.wiki, phrases.pdf, phrases.transcript].map(query => search(onto, alphaWiki, query, corpus.reader)),
      )).every(hits => hits.length === 1));
      const observations = await Promise.all([
        search(onto, alphaWiki, phrases.wiki.toUpperCase(), corpus.reader),
        search(onto, alphaWiki, phrases.pdf, corpus.reader),
        search(onto, alphaWiki, phrases.transcript, corpus.reader),
      ]);
      assert.deepEqual(observations.map(hits => hits.length), [1, 1, 1]);
      const [[page], [pdf], [transcript]] = observations;
      assert.deepEqual(await search(onto, alphaWiki, "Unpublished cerulean draft"), []);
      await Promise.all(observations.map(async ([expected], index) => {
        const query = [phrases.wiki.toUpperCase(), phrases.pdf, phrases.transcript][index];
        const { wikiPassageSearch } = await allowedDocument<{ wikiPassageSearch: { passages: Passage[]; next: string | null } }>(
          await documentCall(onto, passageDocuments.search, { ...alphaWiki, query }, connected(corpus.reader)));
        assert.equal(wikiPassageSearch.next, null);
        assert.equal(wikiPassageSearch.passages.length, 1);
        const [hit] = wikiPassageSearch.passages;
        assert.equal(hit.id, expected.id);
        assert.equal(hit.text, expected.text);
        assert.equal(hit.source.pageSlug, expected.source.pageSlug);
        assert.equal(hit.source.version, expected.source.version);
        assert.equal(hit.source.contentHash, expected.source.contentHash);
        assert.deepEqual(Object.fromEntries(Object.entries(hit.locator).filter(([, value]) => value !== null)), expected.locator);
      }));
      for (const passage of [page, pdf, transcript]) {
        assert.equal(passage.source.installationId, alphaWiki.wikiInstallationId);
        assert.equal(passage.source.organizationId, alpha.organizationId);
        assert.equal(passage.source.pageSlug, sourceSlug);
        assert.match(passage.source.version, /^[a-f0-9]{64}$/);
      }
      assert.equal(page.source.revision, fixture.page.revision);
      assert.equal(page.source.documentId, fixture.page.id);
      for (const attachment of [pdf, transcript]) {
        assert.equal(attachment.source.revision, null);
        assert.equal(attachment.source.documentId, null);
      }
      const readPage = async (after?: string) => (await allowedDocument<{ wikiPassageSearch: {
        passages: Passage[]; next: string | null;
      } }>(await documentCall(onto, passageDocuments.search, { ...alphaWiki, query: "e", limit: 1, after }, corpus.reader))).wikiPassageSearch;
      const first = await readPage();
      assert.equal(first.passages.length, 1);
      assert.equal(first.next, first.passages[0].id);
      const second = await readPage(first.next!);
      assert.equal(second.passages.length, 1);
      assert.notEqual(second.passages[0].id, first.passages[0].id);
      const pageDigest = createHash("sha256").update(JSON.stringify([
        fixture.page.id, fixture.page.revision, sourceTitle, "", sourceText.wiki, "",
      ])).digest("hex");
      assert.equal(page.source.contentHash, pageDigest);
      assert.equal(pdf.source.sha256, fixture.pdf.sha256);
      assert.equal(pdf.source.contentHash, fixture.pdf.sha256);
      assert.equal(transcript.source.contentHash, fixture.transcript.sha256);
      assert.equal(transcript.source.sha256, fixture.transcript.sha256);
      assert.deepEqual(page.locator, { kind: "wiki-page", section: "body", start: 0, end: sourceText.wiki.length });
      assert.equal(pdf.locator.kind, "pdf-page");
      assert.equal(pdf.locator.page, 2);
      assert.equal(pdf.locator.start, 0);
      assert.equal(pdf.locator.end, pdf.text.length);
      assert.deepEqual(transcript.locator, { kind: "transcript", startMs: 133500, endMs: 139750, start: 0, end: sourceText.transcript.length });
      assert.deepEqual([page.text, pdf.text.trimEnd(), transcript.text], [sourceText.wiki, sourceText.pdf, sourceText.transcript]);
      assert.deepEqual(await graphState(onto), { node: { body: initialBody, revision: 1, edges: { totalCount: 0 } } });
      assert.ok(collectProgress().length > 0);
      assert.ok(onto.calls.some(call => call.input.action === "passage.verify" && call.status === 200));
      const state = await progress();
      assert.equal(state.cursor, null);
      assert.ok(state.sweeps > 0);
      assert.equal(state.indexedSources, 3);
      assert.equal(state.pendingSources, 0);
      assert.equal(state.lastError, null);
      assert.equal(state.indexedPassages, 6);
      const collected = collectProgress().at(-1)?.input.value;
      assert.deepEqual(collected, state);
      return { outcomes, page, pdf, transcript, progress: state, collected };
    });

  await check("owner-isolation-and-negative-inference",
    "Each member finds only their own corpus. A foreign Wiki request, foreign batch and foreign anchor cannot cross organizations. Empty inference creates no batch", async () => {
      const outcomes = await advance(other, async () => (await search(other, betaWiki, phrases.foreign)).length === 1);
      assert.deepEqual(await search(other, betaWiki, phrases.wiki, foreignCorpus.reader), []);
      assert.deepEqual(await search(onto, alphaWiki, phrases.foreign, corpus.reader), []);
      const foreignSearch = await denied(await other.action("passage.search", { ...alphaWiki, query: phrases.wiki }));
      const betaBatches = await batches(other);
      assert.deepEqual(betaBatches, []);
      assert.ok(other.calls.some(call => call.operation === "inference.generate" &&
        JSON.stringify(call.input.data).includes(phrases.foreign)));
      return { foreignSearch, outcomes, betaBatches };
    });

  const routing = await check("routed-and-unresolved-anchor-review",
    "Two batches enter member review, including a new node linked to a proposal with three named anchors. Six held suggestions have explicit reasons", async () => {
      const outcomes = await advance(onto, async () => (await batches(onto)).length === 2);
      const pending = await batches(onto);
      assert.equal(pending.length, 2);
      const records = await Promise.all(pending.map(batch => batchDetails(onto, batch.id)));
      assert.ok(records.every(record => record.batch.state === "awaiting_review"));
      for (const record of records) assert.ok(record.operations.every(op => op.state === "awaiting_review"));
      function cited(quote: string) {
        const match = records.find(record => record.operations.some(op => op.evidence.some(item => item.quote === quote)));
        assert.ok(match, quote);
        return match;
      }
      const single = cited(sourceText.wiki);
      const multiple = cited(sourceText.pdf);
      assert.deepEqual(single.batch.anchors, [sensor]);
      assert.deepEqual(multiple.batch.anchors?.slice().sort(), [sensor, recorder, relay].sort());
      assert.equal(multiple.operations.length, 4);
      const [wikiEvidence] = single.operations[0].evidence;
      const [pdfEvidence] = multiple.operations[0].evidence;
      assert.deepEqual(wikiEvidence, {
        provider: "wiki", quote: sourceText.wiki,
        recordId: `${alphaWiki.wikiInstallationId}/${citations.page.source.sourceId}#section=body&characters=0-${sourceText.wiki.length}`,
        version: `page:${citations.page.source.pageRevision};document:1`, contentHash: citations.page.source.contentHash,
      });
      assert.deepEqual(pdfEvidence, {
        provider: "wiki", quote: sourceText.pdf,
        recordId: `${alphaWiki.wikiInstallationId}/${citations.pdf.source.sourceId}#page=2&characters=0-${sourceText.pdf.length}`,
        version: `page:${citations.pdf.source.pageRevision};document:none;sha256:${fixture.pdf.sha256}`, contentHash: fixture.pdf.sha256,
      });
      for (const op of multiple.operations) assert.deepEqual(op.evidence, [pdfEvidence]);
      const unresolved = await onto.read<{ suggestions: Array<{ issue: string; plan: { evidence: { recordId: string } | null } }> }>(
        "passage.unresolved", alphaWiki,
      );
      assert.deepEqual(unresolved.suggestions.map(item => item.issue).sort(), [
        "Ambiguous anchor: Shared Receiver",
        "Anchor is not named in the evidence quote: EvalInstrument:amber-recorder",
        "Anchor is not named in the evidence quote: EvalInstrument:copper-sensor",
        "Missing anchor: EvalInstrument:never-seeded",
        "Missing anchor: EvalInstrument:obsidian-sextant",
        "Quote does not match the indexed passage",
      ].sort());
      assert.match(unresolved.suggestions.find(item => item.issue.startsWith("Ambiguous"))!.plan.evidence?.recordId ?? "",
        /#startMs=133500&endMs=139750&characters=0-/);
      const fabricated = unresolved.suggestions.find(item => item.issue.startsWith("Quote does not match"));
      assert.equal(fabricated?.plan.evidence, null);
      const state = await progress();
      assert.equal(state.routed, 2);
      assert.equal(state.unresolved, 6);
      const status = await allowedDocument<{
        wikiPassageProgress: Progress;
        wikiPassageHeldItems: { suggestions: { issue: string }[] };
      }>(await documentCall(onto, passageDocuments.status, alphaWiki, corpus.reader));
      assert.deepEqual(status.wikiPassageProgress, state);
      assert.deepEqual(status.wikiPassageHeldItems.suggestions.map(item => item.issue), unresolved.suggestions.map(item => item.issue));
      const limited = await allowedDocument<typeof status>(
        await documentCall(onto, passageDocuments.status, { ...alphaWiki, limit: 1 }, corpus.reader));
      assert.equal(limited.wikiPassageProgress.unresolved, 6);
      assert.equal(limited.wikiPassageHeldItems.suggestions.length, 1);
      const blockedReader = { ...corpus.reader, userId: "eval-reader-without-wiki" };
      onto.denyWikiAccess(blockedReader);
      const visibleCard = JSON.stringify(await json(await onto.reviewCard(corpus.reader)));
      assert.match(visibleCard, /Wiki passage suggestion/);
      const blockedCard = JSON.stringify(await json(await onto.reviewCard(blockedReader)));
      assert.doesNotMatch(blockedCard, /Wiki passage suggestion/);
      assert.equal(state.pendingPassages, 0);
      assert.equal(state.pendingSuggestions, 0);
      assert.ok(!JSON.stringify(records).includes("obsidian-sextant"));
      await denied(await other.action("batch.get", { batchId: single.batch.id }));
      return { outcomes, records, single, multiple, unresolved, progress: state };
    });

  await check("review-worker-and-replay",
    "The installed review workflow persists reviews without committing graph changes. A replay and clean sweep preserve passage and batch IDs", async () => {
      const before = await batches(onto);
      await onto.read("onto.schedule", {});
      const reviewOutcomes = [];
      for (const batch of before) {
        const result = await json<{ outcome: string; runId?: string }>(await onto.occurrence("batch-review"));
        assert.ok(["started", "resumed"].includes(result.outcome), JSON.stringify(result));
        reviewOutcomes.push(result);
        assert.equal((await batchDetails(onto, batch.id)).batch.state, "awaiting_review");
      }
      const reviewed = await Promise.all(before.map(batch => batchDetails(onto, batch.id)));
      for (const record of reviewed) {
        const review = record.batch.review;
        assert.equal(review?.state, "complete", JSON.stringify(review));
        assert.equal(review.decision?.approved, 0);
        assert.equal(review.decision?.held.length, record.operations.length);
        assert.ok(onto.calls.some(call => call.operation === "workflow.collect" &&
          call.input.slot === "review.outputs.findings" && call.input.runId === review.runId));
      }
      assert.deepEqual(await graphState(onto), { node: { body: initialBody, revision: 1, edges: { totalCount: 0 } } });
      const runId = crypto.randomUUID();
      const results = [];
      for (const id of [runId, runId, crypto.randomUUID()]) {
        results.push(await json(await onto.occurrence(indexWorkflow, { runId: id })));
      }
      assert.equal(onto.calls.filter(call => call.operation === "workflow.start" && call.input.id === runId).length, 1);
      assert.equal(onto.calls.filter(call => call.operation === "workflow.collect" && call.input.runId === runId).length, 1);
      assert.deepEqual(await batches(onto), before);
      assert.equal((await search(onto, alphaWiki, phrases.wiki))[0]?.id, citations.page.id);
      assert.equal((await search(onto, alphaWiki, phrases.pdf))[0]?.id, citations.pdf.id);
      assert.equal((await search(onto, alphaWiki, phrases.transcript))[0]?.id, citations.transcript.id);
      return { results, reviewOutcomes, batches: reviewed.map(record => record.batch), progress: await progress() };
    });

  await check("portable-archive-authority",
    "Backup retains index runtime state. Portable import cannot mint it or amend an existing passage review", async () => {
      const target = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-portable-target");
      t.after(() => target.dispose());
      const runtime = new Set<string>();
      let forgedReviewStatus: number | null = null;
      let cursor: string | null = null;
      do {
        const archive: AppArchive = await json(await onto.app.call(
          `/api/outfitter/data/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, alpha,
        ));
        const batchTable = archive.tables.graph_batches;
        if (forgedReviewStatus === null && batchTable?.rows.length) {
          const changed = [...batchTable.rows[0]];
          changed[batchTable.columns.indexOf("title")] = "Forged portable review title";
          const updatedAt = batchTable.columns.indexOf("updatedAt");
          changed[updatedAt] = Number(changed[updatedAt]) + 1;
          const forged = await onto.app.call("/api/outfitter/data/preview", alpha, {
            method: "POST", body: { archive: { ...archive, tables: { graph_batches: { ...batchTable, rows: [changed] } } } },
          });
          assert.equal(forged.status, 409, await forged.clone().text());
          assert.match(await forged.text(), /cannot amend local Wiki passage reviews/);
          forgedReviewStatus = forged.status;
        }
        const stateTables = Object.entries(archive.tables)
          .filter(([table, value]) => /passage/.test(table) && value.rows.length > 0)
          .map(([table]) => table);
        stateTables.forEach(table => runtime.add(table));
        const preview = await json<{ previewToken: string; tables: Array<{ table: string }> }>(
          await target.call("/api/outfitter/data/preview", alpha, { method: "POST", body: { archive } }),
        );
        for (const table of stateTables) assert.ok(!preview.tables.some(row => row.table === table), table);
        await json(await target.call("/api/outfitter/data/import", alpha, {
          method: "POST", body: { archive, previewToken: preview.previewToken },
        }));
        cursor = archive.cursor;
      } while (cursor);
      assert.deepEqual([...runtime].sort(), [
        "onto_passage_indexes", "onto_passage_sources", "onto_passage_suggestions", "onto_passages",
      ]);
      for (const table of runtime) {
        assert.match(table, /^[a-z_]+$/);
        assert.equal((await target.database.prepare(`SELECT count(*) AS n FROM "${table}"`).first())?.n, 0, table);
      }
      assert.equal(forgedReviewStatus, 409);
      return { retainedInBackup: [...runtime].sort(), runtimeRowsImported: 0, forgedReviewStatus };
    });

  await check("approval-revalidates-current-graph", "A newly ambiguous anchor blocks approval without changing the graph", async () => {
    await onto.read("graph.apply", { requestKey: "introduce-ambiguous-anchor", operations: [
      node(9, "copper-sensor-shadow", "Copper Sensor"),
    ] });
    const response = await onto.review(routing.single.batch.id);
    assert.equal(response.status, 409, await response.clone().text());
    assert.match(await response.text(), /Ambiguous anchor: Copper Sensor/);
    assert.equal((await batchDetails(onto, routing.single.batch.id)).batch.state, "awaiting_review");
    assert.deepEqual(await graphState(onto), { node: { body: initialBody, revision: 1, edges: { totalCount: 0 } } });
    await onto.read("graph.apply", { requestKey: "archive-ambiguous-anchor", operations: [{
      operation: "update", ref: "$shadow", type: "graph-node", id: "EvalInstrument:copper-sensor-shadow",
      revision: 1, attributes: { archived: true },
    }] });
    return { status: response.status };
  });

  const revised = await check("revision-and-live-verification",
    "A saved draft stays out of search. Publication supersedes the page pin while immutable attachment pins and review batches survive", async () => {
      const draft = await corpus.save(phrases.revised, fixture.page);
      await json(await onto.occurrence());
      assert.equal((await search(onto, alphaWiki, phrases.wiki))[0]?.id, citations.page.id);
      assert.deepEqual(await search(onto, alphaWiki, phrases.revised), []);
      assert.equal((await search(onto, alphaWiki, phrases.pdf))[0]?.id, citations.pdf.id);
      assert.equal((await batchDetails(onto, routing.single.batch.id)).batch.state, "awaiting_review");
      const updated = await corpus.publish(draft);
      assert.equal(updated.revision, fixture.page.revision + 1);
      assert.deepEqual(await search(onto, alphaWiki, phrases.wiki), []);
      const rejected = await onto.review(routing.single.batch.id);
      assert.equal(rejected.status, 409, await rejected.clone().text());
      assert.match(await rejected.text(), /Wiki source changed/);
      const outcomes = await advance(onto, async () => (await search(onto, alphaWiki, phrases.revised)).length === 1);
      const [hit] = await search(onto, alphaWiki, phrases.revised);
      assert.equal(hit.source.revision, updated.revision);
      assert.notEqual(hit.source.version, citations.page.source.version);
      assert.notEqual(hit.source.contentHash, citations.page.source.contentHash);
      assert.notEqual(hit.id, citations.page.id);
      const [freshPdf] = await search(onto, alphaWiki, phrases.pdf);
      assert.equal(freshPdf.source.revision, null);
      assert.equal(freshPdf.source.sha256, fixture.pdf.sha256);
      assert.equal(freshPdf.source.version, citations.pdf.source.version);
      assert.equal(freshPdf.id, citations.pdf.id);
      const previousIds = new Set(routing.records.map(record => record.batch.id));
      const previous = (await batches(onto)).filter(batch => previousIds.has(batch.id));
      assert.equal(previous.length, 2);
      assert.equal(previous.find(batch => batch.id === routing.single.batch.id)?.state, "discarded");
      assert.equal(previous.find(batch => batch.id === routing.multiple.batch.id)?.state, "awaiting_review");
      const oldDetails = await Promise.all(routing.records.map(record => batchDetails(onto, record.batch.id)));
      assert.deepEqual(oldDetails.map(record => record.operations.map(op => op.evidence)),
        routing.records.map(record => record.operations.map(op => op.evidence)));
      return { updated, hit, freshPdf, outcomes, staleApproval: rejected.status, priorBatches: previous };
    });

  await check("passage-review-is-atomic", "A three-anchor proposal cannot be partially rejected or approved after a prior partial decision", async () => {
    const batchId = routing.multiple.batch.id;
    const ref = "$relay-to-spectrometer";
    const newNode = () => graphQuery<{ node: { id: string } | null }>(onto, `{ node(id: "${spectrometer}") { id } }`);
    const before = await graphState(onto);

    const version = await onto.app.database.prepare("SELECT submittedVersion FROM graph_batches WHERE id=?")
      .bind(batchId).first<number>("submittedVersion");
    assert.equal(typeof version, "number");
    const feedback = await onto.review(batchId, "request_changes", [ref], {
      expectedVersion: version!, comment: "Review the cited source before proceeding.",
    });
    assert.equal(feedback.status, 409, await feedback.clone().text());
    assert.match(await feedback.text(), /Wiki passage suggestions must be decided as submitted/);

    const rejected = await onto.review(batchId, "reject", [ref]);
    assert.equal(rejected.status, 409, await rejected.clone().text());
    assert.match(await rejected.text(), /Reject the complete Wiki passage proposal/);
    assert.ok((await batchDetails(onto, batchId)).operations.every(op => op.state === "awaiting_review"));

    // Recreate a partial decision written before the complete-rejection guard existed.
    const setState = onto.app.database.prepare("UPDATE graph_batch_operations SET state=? WHERE batchId=? AND ref=?");
    await setState.bind("rejected", batchId, ref).run();
    try {
      const approved = await onto.review(batchId);
      assert.equal(approved.status, 409, await approved.clone().text());
      assert.match(await approved.text(), /Approve the complete Wiki passage proposal/);
      const after = await batchDetails(onto, batchId);
      assert.equal(after.batch.state, "awaiting_review");
      assert.deepEqual(after.operations.map(op => op.state), ["awaiting_review", "awaiting_review", "awaiting_review", "rejected"]);
      assert.equal((await newNode()).node, null);
      assert.deepEqual(await graphState(onto), before);
      return { feedback: feedback.status, partialReject: rejected.status, legacyPartialApproval: approved.status, state: after.batch.state };
    } finally {
      await setState.bind("awaiting_review", batchId, ref).run();
    }
  });

  await check("member-approval-and-history", "An explicit editor approval commits the complete proposal and retains precise citation metadata in graph history", async () => {
    await json(await onto.review(routing.multiple.batch.id));
    const reviewed = await batchDetails(onto, routing.multiple.batch.id);
    assert.equal(reviewed.batch.state, "committed");
    assert.equal((await graphState(onto)).node.edges.totalCount, 2);
    for (const operation of reviewed.operations) {
      assert.equal(operation.state, "committed");
      assert.ok(operation.recordId);
      const history = await json<{ revisions: { batchId: string; evidence: unknown[]; approval: { kind: string } }[] }>(
        await onto.app.call(`/api/apps/onto/batches/history?id=${operation.recordId}`, alpha));
      const revision = history.revisions[0];
      assert.equal(revision.batchId, reviewed.batch.id);
      assert.equal(revision.approval.kind, "member");
      assert.deepEqual(revision.evidence, operation.evidence.map(({ quote: _quote, ...citation }) => citation));
    }
    return { batchId: reviewed.batch.id, committed: reviewed.operations.length };
  });

  await check("source-archive-and-sweep",
    "Archive immediately hides the page and its attachments while retaining Wiki revision history", async () => {
      await corpus.archive(revised.updated);
      for (const term of [phrases.wiki, phrases.revised, phrases.pdf, phrases.transcript]) {
        assert.deepEqual(await search(onto, alphaWiki, term, corpus.reader), []);
      }
      const history = await json<{ document: { revision: number; body: string } }>(await corpus.wiki.call(
        "/api/apps/wiki-map/documents", corpus.reader, { method: "POST", body: {
          operation: "WikiDocument", variables: { id: fixture.page.id, revision: fixture.page.revision },
        } },
      ));
      assert.equal(history.document.revision, fixture.page.revision);
      assert.equal(history.document.body, sourceText.wiki);
      const swept = await json(await onto.occurrence());
      const state = await progress();
      assert.equal(state.indexedSources, 0);
      assert.equal(state.indexedPassages, 0);
      assert.equal(state.pendingSuggestions, 0);
      return { swept, progress: state, history };
    });


});

test("stale inference and routing work defer before the source inventory reaches them", { timeout: 180_000 }, async t => {
  const corpus = await createWikiCorpus(alpha, alphaWiki.wikiInstallationId);
  t.after(() => corpus.wiki.dispose());
  const onto = await createOntoHarness(alpha, corpus, () => ({ suggestions: [] }));
  t.after(() => onto.app.dispose());
  const staleDocument = await corpus.publish(await corpus.save("Queue stale marker"));
  const freshDocument = await corpus.publish(await corpus.save("Queue active marker", undefined, "queue-active-page"));
  await onto.read("passage.schedule", alphaWiki);
  await json(await onto.occurrence());
  const [stale] = await search(onto, alphaWiki, "Queue stale marker");
  const [fresh] = await search(onto, alphaWiki, "Queue active marker");
  assert.ok(stale && fresh);
  await corpus.publish(await corpus.save("Queue replacement marker", staleDocument));

  // A synthetic inventory taller than one occurrence's 400-source discovery
  // budget keeps the changed source outside the current cursor window.
  const inventoryIds = Array.from({ length: 401 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  assert.ok(stale.source.sourceId > `page:${inventoryIds.at(-1)}`);
  await corpus.wiki.database.prepare(`INSERT INTO wiki_pages(id,slug,documentId,updatedAt)
    SELECT value,'fixture-' || value,?,? FROM json_each(?)`).bind(freshDocument.id, Date.now(), JSON.stringify(inventoryIds)).run();
  const db = onto.app.database;
  const staleIds = Array.from({ length: 90 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
  const firstActive = "fff".padStart(64, "0");
  await db.batch([
    db.prepare(`INSERT INTO onto_passages(id,organizationId,wikiInstallationId,sourceId,version,text,searchText,locator)
      SELECT item.value,p.organizationId,p.wikiInstallationId,p.sourceId,p.version,p.text,p.searchText,p.locator
      FROM onto_passages p CROSS JOIN json_each(?) item WHERE p.id=?`).bind(JSON.stringify(staleIds), stale.id),
    db.prepare(`INSERT INTO onto_passage_suggestions(id,organizationId,wikiInstallationId,sourceId,version,passageId,plan,state)
      SELECT p.id,p.organizationId,p.wikiInstallationId,p.sourceId,p.version,p.id,'{}','pending'
      FROM onto_passages p WHERE p.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(staleIds)),
    db.prepare("UPDATE onto_passages SET id=?,inferred=0 WHERE id=?").bind(firstActive, fresh.id),
  ]);

  const before = Date.now();
  const earlierCalls = onto.calls.length;
  await json(await onto.occurrence());
  assert.ok((await onto.read<Progress>("passage.progress", alphaWiki)).cursor);
  for (const table of ["onto_passages", "onto_passage_suggestions"]) {
    const deferred = await db.prepare(`SELECT count(*) AS n FROM ${table}
      WHERE retryAt>? AND id IN (SELECT value FROM json_each(?))`).bind(before, JSON.stringify(staleIds)).first();
    assert.equal(deferred?.n, staleIds.length);
  }
  assert.equal((await db.prepare("SELECT inferred FROM onto_passages WHERE id=?").bind(firstActive).first())?.inferred, 1);
  const requests = onto.calls.slice(earlierCalls).filter(call => call.operation === "inference.generate");
  const sizes = requests.map(call => (call.input.data as { passages: unknown[] }).passages.length);
  assert.ok(sizes.every(size => size <= 4));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) > 24);
});

test("published passage documents enforce installation and caller access", async t => {
  const corpus = await createWikiCorpus(alpha, alphaWiki.wikiInstallationId);
  t.after(() => corpus.wiki.dispose());
  const onto = await createOntoHarness(alpha, corpus, inference);
  t.after(() => onto.app.dispose());
  onto.denyWikiAccess(corpus.reader);
  const org = { kind: "organization", id: alpha.organizationId } as const;
  const external = { ...corpus.reader, role: "external", callerOrganizationId: beta.organizationId };
  for (const doc of [passageDocuments.search, passageDocuments.status]) {
    const variables = doc === passageDocuments.search ? { ...alphaWiki, query: phrases.wiki } : alphaWiki;
    await refusedDocument(await documentCall(onto, doc, variables, corpus.reader), 403);
    await refusedDocument(await documentCall(onto, doc, { ...variables, ...betaWiki }), 404);
    const hostCalls = onto.calls.length;
    const response = await onto.app.dispatch("", new Request(`${onto.app.origin}${actionsPath}`, {
      method: "POST",
      headers: { ...identityHeaderValues({ ...external, owner: org, installationId: `onto-${alpha.organizationId}` }), "content-type": "application/json" },
      body: JSON.stringify({ action: "graph.graphql", input: documentInput(doc, variables), access: "read" }),
    }));
    const result = graphGraphqlResult.parse(await json(response));
    assert.equal(result.data, null);
    assert.ok(result.errors?.some(error => error.message.includes("Cannot query field")), JSON.stringify(result.errors));
    assert.equal(onto.calls.length, hostCalls);
  }
  const hostCalls = onto.calls.length;
  const response = await onto.app.dispatch("", new Request(`${onto.app.origin}${actionsPath}`, {
    method: "POST",
    headers: { ...identityHeaderValues({ ...external, owner: org, installationId: `onto-${alpha.organizationId}` }), "content-type": "application/json" },
    body: JSON.stringify({ action: "graph.mutate", input: documentInput(passageDocuments.enable, alphaWiki) }),
  }));
  assert.equal(await denied(response), 403);
  assert.equal(onto.calls.length, hostCalls);
  assert.equal(onto.schedules.size, 0);
});

test("the flat personal installation cannot enable or search organization passages", async t => {
  await check("flat-personal-scope", "Personal owner receives HTTP 404 before any host operation", async () => {
    const userId = "eval-personal-owner";
    const installationId = "onto-eval-personal";
    let hostCalls = 0;
    const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), installationId, {
      workflowHost: () => ({
        call: async () => {
          hostCalls++;
          return { ok: false, status: 500, message: "Personal scope unexpectedly reached the host" };
        },
      }),
    });
    t.after(() => app.dispose());
    const headers = identityHeaderValues({
      userId, installationId, role: "owner", owner: { kind: "user", id: userId },
    });
    const statuses: Record<string, number> = {};
    for (const [action, input] of [
      ["passage.schedule", alphaWiki],
      ["passage.search", { ...alphaWiki, query: phrases.wiki }],
    ] as const) {
      const response = await app.dispatch("", new Request(`${app.origin}${actionsPath}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action, input }),
      }), {
        workflowHost: {
          organizationId: null, installationId, userId, packageHash: "synthetic-package",
          phase: "interactive", expiresAt: Date.now() + 60_000,
        },
      });
      assert.equal(response.status, 404, await response.text());
      statuses[action] = response.status;
    }
    for (const doc of Object.values(passageDocuments)) {
      const variables = doc === passageDocuments.search ? { ...alphaWiki, query: phrases.wiki } : alphaWiki;
      const response = await app.dispatch("", new Request(`${app.origin}${actionsPath}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ action: doc.kind === "query" ? "graph.graphql" : "graph.mutate", input: documentInput(doc, variables) }),
      }), {
        workflowHost: {
          organizationId: null, installationId, userId, packageHash: "synthetic-package",
          phase: "interactive", expiresAt: Date.now() + 60_000,
        },
      });
      await refusedDocument(response, 404);
    }
    assert.equal(hostCalls, 0);
    return { statuses, hostCalls };
  });
});
