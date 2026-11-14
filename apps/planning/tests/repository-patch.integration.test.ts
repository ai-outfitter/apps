import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiFixtureCall } from "@ai-outfitter/app-test/wiki-fixture";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const projectId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";

test("patchProject publishes multiple repositories, creates its canonical Wiki Project, and supports retries and removals", async () => {
  const wiki = await appWorker("wiki-map", appArtifact(new URL("../../onto", import.meta.url), "operational"), "repository-patch-wiki");
  // Onto checks edge endpoints against existing types, so seed its standard types as an installed Wiki has them.
  assert.equal((await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const calls: string[] = [];
  let failPublication = false;
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "repository-patch-planning", {
    workflowHost: () => ({ call: async (operation, input) => {
      calls.push(operation === "actions.call" ? String((input as any).action) : operation);
      if (operation === "actions.call" && (input as any).action === "graph.apply" && failPublication)
        return { ok: false, status: 503, message: "Wiki temporarily unavailable" };
      return wikiFixtureCall(wiki, { ...owner, actor: { kind: "app", id: "repository-patch-planning" } }, operation, input);
    } }),
  });
  const scope = { organizationId: "org", installationId: app.installationId, userId: owner.userId, packageHash: "test", phase: "interactive" as const, expiresAt: Date.now() + 600000 };
  const graphql = async (query: string, variables: object = {}, who = owner, mutation = false) => {
    const response = await app.call("/api/internal/actions/v1/call", who, { method: "POST", workflowHost: scope,
      body: { action: mutation ? "graph.mutate" : "graph.graphql", input: { query, variables } } });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as any;
  };
  const patch = (revision: number, repositories: object[], who = owner, id = projectId) => graphql(
    'mutation($input:PatchProjectInput!){patchProject(input:$input){id revision githubRepository repositoryChanges}}',
    { input: { project: { id, revision }, mask: { repositories } } }, who, true);
  const read = async () => {
    const result = await graphql('query($ids:[ID!]){projects(ids:$ids){nodes{id githubRepository repositories(first:50){nodes{id url path ref} aggregate{count}}}}}', { ids: [projectId] });
    assert.equal(result.errors, undefined, JSON.stringify(result));
    return result.data.projects.nodes[0];
  };
  const wikiRows = async (type: string) => {
    const response = await wiki.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type, limit: 100 } });
    assert.equal(response.status, 200, await response.clone().text()); return await response.json() as EntityRecord[];
  };
  const one = { url: "https://github.com/acme/one", path: "app", ref: "main" };
  const two = { url: "https://github.com/acme/two" };
  try {
    for (const [id, installation] of [[projectId, app.installationId], [foreignId, "foreign-planning"]])
      await app.database.prepare("INSERT INTO planning_projects(id,installationId,name,githubRepository,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,'https://github.com/acme/old','seed','seed',1,1)").bind(id, installation, "Project").run();
    const before = (await wikiRows("graph-node")).length;
    assert.equal((await read()).repositories.nodes[0].url, "https://github.com/acme/old", "legacy-only project remains readable");
    calls.length = 0;
    assert.ok((await patch(1, [one, two], { ...owner, role: "member" })).errors?.length);
    assert.ok((await patch(1, [one, two], owner, foreignId)).errors?.length);
    assert.ok((await patch(9, [one, two])).errors?.length);
    assert.equal(calls.length, 0, "denied and stale requests cause no Wiki calls");
    failPublication = true;
    const firstFailure = await patch(1, [one, two]);
    assert.equal(firstFailure.errors, undefined, JSON.stringify(firstFailure));
    assert.equal(firstFailure.data.patchProject.repositoryChanges.state, "failed");
    assert.equal(firstFailure.data.patchProject.githubRepository, "https://github.com/acme/old", "failed publication retains the legacy fallback");
    assert.equal((await read()).repositories.nodes[0].url, "https://github.com/acme/old");
    failPublication = false;
    const added = await patch(firstFailure.data.patchProject.revision, [one, two]);
    assert.equal(added.errors, undefined, JSON.stringify(added));
    let saved = added.data.patchProject;
    assert.equal(saved.repositoryChanges.state, "published");
    assert.equal(saved.githubRepository, null);
    assert.equal(calls.filter(call => call === "entities.create").length, 1);
    assert.ok(!calls.includes("graph.mutate"), "app publication needs no review batch");
    const nodes = await wikiRows("graph-node");
    const anchors = nodes.filter(row => row.references.some(ref => ref.installationId === app.installationId && ref.id === projectId));
    assert.equal(anchors.length, 1);
    assert.deepEqual(anchors[0].references, [{ installationId: app.installationId, type: "project", id: projectId }]);
    assert.equal(nodes.length, before + 3);
    let rows = (await read()).repositories.nodes;
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row: any) => row.path === "app" && row.ref === "main"));
    assert.ok((await patch(1, [two])).errors?.length, "old revision cannot change published links");
    const again = await patch(saved.revision, [one, two]); saved = again.data.patchProject;
    assert.equal(saved.repositoryChanges.state, "unchanged");
    assert.equal((await wikiRows("graph-node")).length, nodes.length, "retry reuses nodes");
    const changed = await patch(saved.revision, [{ ...one, path: "src", ref: "release" }, two]);
    assert.equal(changed.errors, undefined, JSON.stringify(changed)); saved = changed.data.patchProject;
    rows = (await read()).repositories.nodes;
    assert.equal(saved.repositoryChanges.state, "published", JSON.stringify(saved.repositoryChanges));
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row: any) => row.id)).size, 2);
    assert.ok(rows.some((row: any) => row.path === "src" && row.ref === "release"));
    assert.ok(!rows.some((row: any) => row.path === "app"));
    const sharedId = "33333333-3333-4333-8333-333333333333";
    await app.database.prepare("INSERT INTO planning_projects(id,installationId,name,githubRepository,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,'','seed','seed',1,1)").bind(sharedId, app.installationId, "Shared repository project").run();
    const shared = await patch(1, [two], owner, sharedId);
    assert.equal(shared.errors, undefined, JSON.stringify(shared));
    assert.equal(shared.data.patchProject.repositoryChanges.state, "published");
    assert.equal((await wikiRows("graph-node")).length, nodes.length + 1, "another project reuses the repository node");
    const removed = await patch(saved.revision, [two]); saved = removed.data.patchProject;
    assert.equal(removed.errors, undefined, JSON.stringify(removed));
    assert.deepEqual((await read()).repositories.nodes.map((row: any) => row.url), [two.url]);
    failPublication = true;
    const failed = await patch(saved.revision, []); saved = failed.data.patchProject;
    assert.equal(saved.repositoryChanges.state, "failed");
    assert.ok(saved.repositoryChanges.error);
    assert.equal(saved.repositoryChanges.retry.project.revision, saved.revision);
    assert.equal((await read()).repositories.nodes.length, 1, "failed atomic publication preserves links");
    failPublication = false;
    const empty = await patch(saved.revision, []);
    assert.equal(empty.errors, undefined, JSON.stringify(empty));
    assert.equal((await read()).repositories.nodes.length, 0);
    const remaining = await wikiRows("graph-node");
    // Onto's standard seeds include records that start archived; only nodes active before removal must stay active.
    assert.ok(nodes.filter(node => !node.attributes.archived).every(node => remaining.some(row => row.ref.id === node.ref.id && !row.attributes.archived)), "removals preserve shared repository and Project nodes");
    const activeEdges = (await wikiRows("graph-edge")).filter(row => !row.attributes.archived);
    assert.equal(activeEdges.filter(row => row.attributes.fromId === anchors[0].ref.id).length, 0);
    assert.equal(activeEdges.filter(row => row.attributes.fromId === shared.data.patchProject.repositoryChanges.wikiProjectId).length, 1, "another project's shared link survives");
  } finally { await app.dispose(); await wiki.dispose(); }
});

test("patchProject links a project without repositories to an existing or new Onto Project node by slug", async () => {
  const wiki = await appWorker("wiki-map", appArtifact(new URL("../../onto", import.meta.url), "operational"), "project-node-wiki");
  assert.equal((await wiki.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"), "project-node-planning", {
    workflowHost: () => ({ call: (operation, input) => wikiFixtureCall(wiki, { ...owner, actor: { kind: "app", id: "project-node-planning" } }, operation, input) }),
  });
  const scope = { organizationId: "org", installationId: app.installationId, userId: owner.userId, packageHash: "test", phase: "interactive" as const, expiresAt: Date.now() + 600000 };
  const graphql = async (query: string, variables: object = {}, mutation = false) => {
    const response = await app.call("/api/internal/actions/v1/call", owner, { method: "POST", workflowHost: scope,
      body: { action: mutation ? "graph.mutate" : "graph.graphql", input: { query, variables } } });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as any;
  };
  const link = async (id: string, revision: number, projectNode: string) => {
    const result = await graphql('mutation($input:PatchProjectInput!){patchProject(input:$input){revision repositoryChanges projectNodeChanges}}',
      { input: { project: { id, revision }, mask: { projectNode } } }, true);
    assert.equal(result.errors, undefined, JSON.stringify(result));
    return result.data.patchProject;
  };
  const wikiNodes = async () => {
    const response = await wiki.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type: "graph-node", limit: 100 } });
    return await response.json() as EntityRecord[];
  };
  const linkedTo = async (id: string) => (await wikiNodes()).filter(row => row.references.some(ref => ref.installationId === app.installationId && ref.id === id));
  const existingId = "44444444-4444-4444-8444-444444444444";
  const types = await (await wiki.call("/api/internal/entities/v1/list", owner, { method: "POST", body: { type: "graph-type", limit: 100 } })).json() as EntityRecord[];
  const projectType = types.find(row => row.attributes.name === "Project")!.ref.id;
  try {
    for (const [id, name] of [[projectId, "Reduce costs"], [existingId, "Existing context"]])
      await app.database.prepare("INSERT INTO planning_projects(id,installationId,name,githubRepository,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,'','seed','seed',1,1)").bind(id, app.installationId, name).run();
    const created = await link(projectId, 1, "Project:reduce-costs");
    assert.equal(created.projectNodeChanges.state, "created", JSON.stringify(created.projectNodeChanges));
    assert.equal(created.projectNodeChanges.slug, "reduce-costs");
    assert.equal(created.repositoryChanges, null, "no repository is needed");
    const [node] = await linkedTo(projectId);
    assert.equal(node.title, "Reduce costs");
    assert.equal((await link(projectId, created.revision, "reduce-costs")).projectNodeChanges.state, "unchanged");
    const other = await link(projectId, created.revision + 1, "something-else");
    assert.equal(other.projectNodeChanges.state, "failed", "a linked project is not silently moved");
    const response = await wiki.call("/api/internal/entities/v1/create", owner, { method: "POST", body: { type: "graph-node", attributes: { typeId: projectType, title: "Existing context node", slug: "existing-context" }, references: [] } });
    assert.equal(response.status, 200, await response.clone().text());
    const linked = await link(existingId, 1, "existing-context");
    assert.equal(linked.projectNodeChanges.state, "linked", JSON.stringify(linked.projectNodeChanges));
    const anchors = await linkedTo(existingId);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].title, "Existing context node", "linking keeps the node's own title");
    const taken = await link(existingId, linked.revision, "reduce-costs");
    assert.equal(taken.projectNodeChanges.state, "failed");
    const read = await graphql('query($ids:[ID!]){projects(ids:$ids){nodes{id slug}}}', { ids: [projectId, existingId] });
    assert.deepEqual(read.data.projects.nodes.map((row: any) => row.slug).sort(), ["existing-context", "reduce-costs"]);
  } finally { await app.dispose(); await wiki.dispose(); }
});
