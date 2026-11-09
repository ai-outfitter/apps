import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import type { WorkflowHostScope } from "@ai-outfitter/app-sdk/workflow-host";
import { wikiChangeDocuments } from "@ai-outfitter/onto/contracts";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { interviewDocument, wikiTypeIds } from "../src/server/wiki";

// The brand interview in a real Wiki Worker: the app stages the BrandInterview document and the
// records the answers name as one change batch, nothing appears in the graph until the member
// approves it there, and saving again proposes only what changed.
const owner = { userId: "creator", organizationId: "org", role: "owner" };
const scope: WorkflowHostScope = { organizationId: "org", installationId: "creative", userId: "creator", packageHash: "hash", phase: "interactive", expiresAt: Date.now() + 600_000 };
type Worker = Awaited<ReturnType<typeof appWorker>>;
// biome-ignore lint/suspicious/noExplicitAny: test assertions read GraphQL results loosely.
type Result = { data?: Record<string, any> | null; errors?: { message: string; extensions?: { status?: number } }[] };

async function graph(worker: Worker, action: "graph.mutate" | "graph.graphql", query: string, variables: Record<string, unknown>, host = false): Promise<Result> {
  const response = await worker.call(`${actionPath}/call`, owner, {
    method: "POST", ...(host ? { workflowHost: scope } : {}),
    body: { action, input: { query, variables }, ...(action === "graph.graphql" ? { access: "read" } : {}) },
  });
  const text = await response.text();
  return response.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : { errors: [{ message: text, extensions: { status: response.status } }] };
}

const stage = "mutation StageBrandInterview($input: StageBrandInterviewInput!) { stageBrandInterview(input: $input) { batch state proposals wikiPath } }";
const save = "mutation SaveBrandAnswer($input: SaveBrandAnswerInput!) { saveBrandAnswer(input: $input) { id revision } }";

test("the interview and the people, audience and problem it names reach the Wiki only through a reviewed batch", { skip: !process.env.OUTFITTER_WIKI_PACKAGE && "Set OUTFITTER_WIKI_PACKAGE to a built Wiki operational package" }, async () => {
  const wiki = await appWorker("wiki-map", process.env.OUTFITTER_WIKI_PACKAGE!);
  const app = await appWorker("creative-team", appArtifact(new URL("..", import.meta.url), "operational"), "creative", {
    workflowHost: () => ({ call: (operation, raw) => wikiFixtureCall(wiki, owner, operation, raw) }),
  });
  const nodes = async (typeId: string) => (await wiki.database.prepare("SELECT id, title, body FROM graph_nodes WHERE typeId=?").bind(typeId).all()).results as { id: string; title: string; body: string }[];
  const typeId = async (name: string) => ((await wiki.database.prepare("SELECT id FROM graph_types WHERE name=?").bind(name).first()) as { id: string }).id;
  try {
    const init = await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} });
    assert.equal(init.status, 200, await init.clone().text());

    // Nothing to save before the first answer.
    const empty = await graph(app, "graph.mutate", stage, { input: { self: { title: "Ada Creator" } } }, true);
    assert.match(empty.errors?.[0]?.message ?? "", /Answer at least one/);

    for (const [questionId, answer] of [
      ["audience.person", "Night-shift nurses in their first two years."],
      ["audience.bad-day", "Twelve hours on their feet and still behind on charting."],
      ["influences.never-skip", "Naval Ravikant's podcast, every episode."],
    ]) assert.ok((await graph(app, "graph.mutate", save, { input: { questionId, answer } })).data?.saveBrandAnswer);

    const input = { self: { title: "Ada Creator" }, entities: [
      { key: "naval-ravikant", kind: "Person", title: "Naval Ravikant", summary: "Investor and podcaster", questionIds: ["influences.never-skip"], relation: "influenced_by" },
      { key: "new-night-nurses", kind: "CustomerSegment", title: "New night-shift nurses", questionIds: ["audience.person"], relation: "serves_audience" },
      { key: "charting-backlog", kind: "Problem", title: "Charting backlog after shifts", questionIds: ["audience.bad-day"] },
    ] };
    // A relation must link the kind it names.
    const wrong = await graph(app, "graph.mutate", stage, { input: { ...input, entities: [{ ...input.entities[2], relation: "influenced_by" }] } }, true);
    assert.match(wrong.errors?.[0]?.message ?? "", /influenced_by links to a Person/);

    const first = await graph(app, "graph.mutate", stage, { input }, true);
    const saved = first.data?.stageBrandInterview;
    assert.ok(saved, JSON.stringify(first.errors));
    // self, 3 records, the interview; interview_of, 3 mentions, 2 relations.
    assert.equal(saved.proposals, 11);
    assert.equal(saved.state, "awaiting_review");
    assert.match(saved.wikiPath, /^\/apps\/|^https:\/\//);
    assert.equal((await nodes(wikiTypeIds.interview)).length, 0, "nothing commits before review");

    // Saving again while the batch waits is refused, so nothing is proposed twice.
    const twice = await graph(app, "graph.mutate", stage, { input }, true);
    assert.match(twice.errors?.[0]?.message ?? "", /still waiting for review/);

    // The member approves it in the Wiki.
    const review = "mutation ReviewBatch($input: ReviewBatchInput!) { reviewBatch(input: $input) { slug state } }";
    const approved = await graph(wiki, "graph.mutate", review, { input: { batch: saved.batch, verdict: "approve" } });
    assert.equal(approved.data?.reviewBatch.state, "committed", JSON.stringify(approved.errors));

    const [interview] = await nodes(wikiTypeIds.interview);
    const body = interviewDocument.parse(JSON.parse(interview.body));
    const people = await nodes(await typeId("Person"));
    const ada = people.find((row) => row.title === "Ada Creator");
    const naval = people.find((row) => row.title === "Naval Ravikant");
    assert.ok(ada && naval);
    assert.equal(body.subject, ada.id);
    const answer = body.sections.flatMap((section) => section.answers).find((row) => row.questionId === "influences.never-skip");
    assert.deepEqual(answer?.mentions, [naval.id]);
    assert.equal(answer?.answer, "Naval Ravikant's podcast, every episode.");
    const influenced = await wiki.database.prepare("SELECT count(*) AS n FROM graph_edges WHERE typeId=? AND fromId=? AND toId=?").bind(wikiTypeIds.influencedBy, ada.id, naval.id).first();
    assert.equal((influenced as { n: number }).n, 1);
    assert.ok((await nodes(await typeId("CustomerSegment"))).some((row) => row.title === "New night-shift nurses"));

    // The app sees the decision, and saving an unchanged interview proposes nothing.
    const batches = await graph(app, "graph.graphql", "{ brandWikiBatches { nodes { id state proposals } } }", {});
    assert.equal(batches.data?.brandWikiBatches.nodes[0].proposals, 11);
    const again = await graph(app, "graph.mutate", stage, { input: { ...input, self: { existingId: ada.id }, entities: input.entities.map((row) => ({ ...row })) } }, true);
    assert.deepEqual(again.data?.stageBrandInterview, { batch: null, state: null, proposals: 0, wikiPath: saved.wikiPath });

    // A new answer updates the interview document at its revision, in a new batch.
    assert.ok((await graph(app, "graph.mutate", save, { input: { questionId: "mission.sentence", answer: "Help new nurses stay in nursing." } })).data?.saveBrandAnswer);
    const update = await graph(app, "graph.mutate", stage, { input: { self: { existingId: ada.id } } }, true);
    const batch = await graph(wiki, "graph.graphql", wikiChangeDocuments.ChangeBatch.document, { slug: update.data?.stageBrandInterview.batch });
    assert.equal(update.data?.stageBrandInterview.proposals, 1, JSON.stringify(update.errors));
    assert.deepEqual(batch.data?.changeBatch.operations.map((row: { ref: string }) => row.ref), ["$interview"]);
    // Approved, the document keeps the records earlier answers named.
    await graph(wiki, "graph.mutate", review, { input: { batch: update.data?.stageBrandInterview.batch, verdict: "approve" } });
    const updated = interviewDocument.parse(JSON.parse((await nodes(wikiTypeIds.interview))[0].body));
    const answers = updated.sections.flatMap((section) => section.answers);
    assert.deepEqual(answers.find((row) => row.questionId === "influences.never-skip")?.mentions, [naval.id]);
    assert.equal(answers.find((row) => row.questionId === "mission.sentence")?.answer, "Help new nurses stay in nursing.");

    // The Brand page shows where the interview stands.
    const page = await app.call("/brand", owner, { workflowHost: scope });
    const html = await page.text();
    assert.match(html, /In your knowledge graph/);
    assert.match(html, /Your last save \(1 change\) is in your Wiki/);
  } finally {
    await app.dispose();
    await wiki.dispose();
  }
});
