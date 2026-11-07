import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import type { WorkflowHostScope } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";

// The built operational Worker: the documents agents run with graph_mutate, the routes the
// pages run them through, the pages themselves and the sidebar's page context.
const owner = { userId: "creator", organizationId: "org", role: "owner" };
const member = { userId: "reader", organizationId: "org", role: "member" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const scope = (userId: string): WorkflowHostScope => ({
  organizationId: "org", installationId: "creative", userId, packageHash: "hash", phase: "interactive", expiresAt: Date.now() + 60_000,
});

async function withApp(run: (app: Awaited<ReturnType<typeof appWorker>>) => Promise<void>) {
  const app = await appWorker("creative-team", artifact(), "creative", {
    workflowHost: () => ({ call: async () => ({ ok: false, status: 403, message: "Operation not used by this test" }) }),
  });
  try {
    await run(app);
  } finally {
    await app.dispose();
  }
}

type Who = typeof owner;
const mutate = async (app: Awaited<ReturnType<typeof appWorker>>, who: Who, query: string, variables: Record<string, unknown>) => {
  const response = await app.call(`${actionPath}/call`, who, { method: "POST", body: { action: "graph.mutate", input: { query, variables } } });
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read GraphQL results loosely.
  type Body = { data?: Record<string, any>; errors?: { message: string }[] };
  // A refused dispatch answers in plain text; a GraphQL result in JSON.
  return { status: response.status, body: (response.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : { errors: [{ message: text }] }) as Body };
};
const read = async (app: Awaited<ReturnType<typeof appWorker>>, who: Who, query: string, variables: Record<string, unknown> = {}) => {
  const response = await app.call(`${actionPath}/call`, who, { method: "POST", body: { action: "graph.graphql", input: { query, variables }, access: "read" } });
  assert.equal(response.status, 200, await response.clone().text());
  // biome-ignore lint/suspicious/noExplicitAny: test assertions read GraphQL results loosely.
  return ((await response.json()) as { data: Record<string, any> }).data;
};

test("the brand interview saves answers at the revision the caller saw", async () => {
  await withApp(async (app) => {
    const save = "mutation SaveBrandAnswer($input: SaveBrandAnswerInput!) { saveBrandAnswer(input: $input) { id answer revision } }";
    const first = await mutate(app, owner, save, { input: { questionId: "mission.sentence", answer: "  Help nurses recover.  " } });
    assert.deepEqual(first.body.data?.saveBrandAnswer, { id: "mission.sentence", answer: "Help nurses recover.", revision: 1 });
    // A second "first answer" or a stale revision is a conflict, never a silent overwrite.
    const again = await mutate(app, owner, save, { input: { questionId: "mission.sentence", answer: "Other" } });
    assert.match(again.body.errors?.[0]?.message ?? "", /Someone else changed/);
    const next = await mutate(app, owner, save, { input: { questionId: "mission.sentence", answer: "Help nurses recover without quitting.", revision: 1 } });
    assert.equal(next.body.data?.saveBrandAnswer.revision, 2);
    // Unknown questions and members without edit access are refused.
    assert.ok((await mutate(app, owner, save, { input: { questionId: "made.up", answer: "x" } })).body.errors);
    assert.equal((await mutate(app, member, save, { input: { questionId: "story.turn", answer: "x" } })).status, 403);
    const data = await read(app, member, "{ brandQuestions { id } brandAnswers { nodes { id answer revision } } }");
    assert.equal(data.brandQuestions.length, 28);
    assert.deepEqual(data.brandAnswers.nodes, [{ id: "mission.sentence", answer: "Help nurses recover without quitting.", revision: 2 }]);
  });
});

test("a content map branch adds pillars down to angles, and removing a node removes its branch", async () => {
  await withApp(async (app) => {
    const add = "mutation AddMapBranch($input: AddMapBranchInput!) { addMapBranch(input: $input) { added ids } }";
    const branch = await mutate(app, owner, add, { input: { nodes: [
      { title: "Recovering from burnout", children: [{ title: "Why rest doesn't feel restful", children: [
        { title: "Your nervous system is still on shift", research: "My best post on X", children: [{ title: "A story" }, { title: "The science" }] },
      ] }] },
      { title: "Sleep on nights" },
    ] } });
    assert.equal(branch.body.data?.addMapBranch.added, 6, JSON.stringify(branch.body));
    // A whole pillar at once spans several statements (D1 binds at most 100 parameters each).
    const angles = Array.from({ length: 5 }, (_, n) => ({ title: `Angle ${n}` }));
    const wide = await mutate(app, owner, add, { input: { nodes: [{ title: "Who you are outside the job", children: [{ title: "Identity", children: [
      { title: "Idea A", children: angles }, { title: "Idea B", children: angles }, { title: "Idea C", children: angles },
    ] }] }] } });
    assert.equal(wide.body.data?.addMapBranch.added, 20, JSON.stringify(wide.body));
    await mutate(app, owner, "mutation DeleteMapNode($input: DeleteMapNodeInput!) { deleteMapNode(input: $input) { id deleted } }",
      { input: { id: wide.body.data?.addMapBranch.ids[0], revision: 1 } });
    const [pillar] = (branch.body.data?.addMapBranch.ids ?? []) as string[];
    // biome-ignore lint/suspicious/noExplicitAny: test assertions read GraphQL results loosely.
    const nodes = (await read(app, owner, "{ mapNodes { nodes { id parentId level title research position revision } } }")).mapNodes.nodes as Record<string, any>[];
    assert.deepEqual(nodes.map((node) => node.level).sort((a, b) => a.localeCompare(b)), ["angle", "angle", "idea", "pillar", "pillar", "topic"]);
    const idea = nodes.find((node) => node.level === "idea");
    assert.equal(idea?.research, "My best post on X");
    // Angles are the last level.
    const angle = nodes.find((node) => node.level === "angle");
    assert.match((await mutate(app, owner, add, { input: { parentId: angle?.id, nodes: [{ title: "Deeper" }] } })).body.errors?.[0]?.message ?? "", /last level/);
    // Children added later go after their siblings.
    await mutate(app, owner, add, { input: { parentId: pillar, nodes: [{ title: "Leaving the shift at the door" }] } });
    const topics = (await read(app, owner, "query($p: [ID!]) { mapNodes(parentId: $p) { nodes { title position } } }", { p: [pillar] })).mapNodes.nodes;
    assert.deepEqual(topics.map((topic: { title: string; position: number }) => [topic.position, topic.title]).sort((a: (string | number)[], b: (string | number)[]) => Number(a[0]) - Number(b[0])), [[0, "Why rest doesn't feel restful"], [1, "Leaving the shift at the door"]]);
    // A draft written from the idea survives the branch's removal, unlinked.
    const draft = await mutate(app, owner, "mutation SaveDraft($input: SaveDraftInput!) { saveDraft(input: $input) { id revision } }",
      { input: { nodeId: idea?.id, format: "post", title: "Still on shift", body: "Your shift ended at 7." } });
    const pillarNode = nodes.find((node) => node.id === pillar);
    const removed = await mutate(app, owner, "mutation DeleteMapNode($input: DeleteMapNodeInput!) { deleteMapNode(input: $input) { id deleted } }",
      { input: { id: pillar, revision: pillarNode?.revision } });
    assert.equal(removed.body.data?.deleteMapNode.deleted, 6);
    const left = await read(app, owner, "{ mapNodes { nodes { title } } drafts { nodes { id nodeId } } }");
    assert.deepEqual(left.mapNodes.nodes.map((node: { title: string }) => node.title), ["Sleep on nights"]);
    assert.deepEqual(left.drafts.nodes, [{ id: draft.body.data?.saveDraft.id, nodeId: null }]);
  });
});

test("pages render the documents and write through the same documents", async () => {
  await withApp(async (app) => {
    const added = await app.call("/api/apps/creative-team/SaveSource", owner, { method: "POST", body: { input: { kind: "influence", name: "A sleep researcher", examples: "Two systems." } } });
    assert.equal(added.status, 200, await added.clone().text());
    assert.equal((await app.call("/api/apps/creative-team/SaveSource", member, { method: "POST", body: { input: { kind: "own", name: "Mine" } } })).status, 403);
    assert.equal((await app.call("/api/apps/creative-team/BrandChanges", owner, { method: "POST", body: { input: {} } })).status, 404);
    const content = await (await app.call("/content", owner)).text();
    assert.match(content, /A sleep researcher/);
    assert.match(await (await app.call("/", owner)).text(), /1 source/);
    // The deploy check requests the shell without a member.
    assert.equal((await app.call("/")).status, 200);
    for (const path of ["/brand", "/map", "/drafts", "/settings"]) assert.equal((await app.call(path, owner)).status, 200, path);
  });
});

test("the sidebar offers read tools to members and proposal tools to editors", async () => {
  await withApp(async (app) => {
    const context = async (who: Who) => {
      const response = await app.call("/api/apps/creative-team/agent/context?focus=c7ea0000-0000-4000-8000-000000000001", who, { workflowHost: scope(who.userId) });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { actions: { name: string }[] }).actions.map((action) => action.name).sort((a, b) => a.localeCompare(b));
    };
    assert.deepEqual(await context(owner), [
      "creative_team_brand_answer", "creative_team_brand_read", "creative_team_content_profile", "creative_team_content_read", "creative_team_content_source",
      "creative_team_draft_save", "creative_team_drafts_read", "creative_team_map_branch", "creative_team_map_node", "creative_team_map_read",
    ]);
    assert.deepEqual(await context(member), ["creative_team_brand_read", "creative_team_content_read", "creative_team_drafts_read", "creative_team_map_read"]);
  });
});
