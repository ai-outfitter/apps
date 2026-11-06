import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText, type ResultOf } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { graphql } from "../graph/graphql";
import { makeProject, type Project, productRevisionFrom } from "../src/lib/project";

// The built operational worker serves its projects over graph.graphql, the call
// the platform's appGraphql makes (src/lib/app-graphql.ts at the repository root).
const member = { userId: "member", organizationId: "org", role: "member" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const projectsQuery = graphql(`
  query Projects($createdBy: [ID!], $after: String) {
    workshopProjects(first: 2, createdBy: $createdBy, after: $after) {
      nodes { id name revision createdBy updatedAt }
      pageInfo { endCursor hasNextPage }
      aggregate { count }
    }
  }
`);

test("members read projects over graph.graphql, paged and filtered, without the project document", async () => {
  const app = await appWorker("workshop", artifact(), "projects");
  try {
    const updated = new Date(Date.UTC(2026, 10, 2, 9)).toISOString();
    for (const n of [0, 1, 2, 3, 4]) {
      const row = { id: `p-${n}`, name: `Project ${n}`, revision: n + 1, data: "{}", createdBy: n % 2 ? "bea" : "ada", updatedBy: "ada", createdAt: updated, updatedAt: updated };
      await app.database.prepare(`INSERT INTO workshop_projects (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`)
        .bind(...Object.values(row)).run();
    }
    const call = (query: string, variables: Record<string, unknown> = {}) => app.call(`${actionPath}/call`, member, {
      method: "POST", body: { action: "graph.graphql", input: { query, variables }, access: "read" },
    });
    const first = await call(documentText(projectsQuery), { createdBy: ["ada"] });
    assert.equal(first.status, 200, await first.clone().text());
    const page = ((await first.json()) as { data: ResultOf<typeof projectsQuery> }).data.workshopProjects;
    assert.deepEqual(page.nodes.map((node) => [node.id, node.createdBy, node.revision]), [["p-0", "ada", 1], ["p-2", "ada", 3]]);
    assert.equal(page.nodes[0].updatedAt, updated);
    assert.deepEqual([page.pageInfo.hasNextPage, page.aggregate.count], [true, 3]);
    const next = ((await (await call(documentText(projectsQuery), { createdBy: ["ada"], after: page.pageInfo.endCursor })).json()) as { data: ResultOf<typeof projectsQuery> }).data.workshopProjects;
    assert.deepEqual([next.nodes.map((node) => node.id), next.pageInfo.hasNextPage], [["p-4"], false]);
    // The project document (models, CAD plans, evidence) is not in the schema.
    const hidden = (await (await call("{ workshopProjects { nodes { data } } }")).json()) as { errors?: { extensions?: { code?: string } }[] };
    assert.equal(hidden.errors?.[0]?.extensions?.code, "GRAPHQL_VALIDATION_FAILED");
    // Only platform dispatch, with a member's identity, reaches it.
    assert.equal((await app.call(`${actionPath}/call`, undefined, { method: "POST", body: { action: "graph.graphql", input: { query: "{ __typename }" } } })).status, 401);
  } finally {
    await app.dispose();
  }
});

test("a project's Wiki product revision is saved with it and served, filterable, over graph.graphql", async () => {
  const app = await appWorker("workshop", artifact(), "revisions");
  try {
    const revisionId = "8f6b6d2e-3f43-4c3e-9a51-6a1c2f0b7e10";
    const linked = productRevisionFrom(`https://wiki.example.test/product-revisions/${revisionId}`, "SNSP-1 Indoor rev A", "wiki-install");
    assert.deepEqual(linked, { id: revisionId, wikiInstallationId: "wiki-install", title: "SNSP-1 Indoor rev A", url: `https://wiki.example.test/product-revisions/${revisionId}` });
    assert.equal(productRevisionFrom("not a record", "x"), undefined);
    const created = await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { project: { ...makeProject("cube"), productRevision: linked } } });
    assert.equal(created.status, 201, await created.clone().text());
    const project = (await created.json()) as Project;
    await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { example: "holder" } });
    const query = graphql(`
      query Linked($productRevisionId: [ID!]) {
        workshopProjects(productRevisionId: $productRevisionId) {
          nodes { id wikiInstallationId productRevisionId productRevisionTitle }
        }
      }
    `);
    const read = async () => ((await (await app.call(`${actionPath}/call`, member, {
      method: "POST", body: { action: "graph.graphql", input: { query: documentText(query), variables: { productRevisionId: [revisionId] } }, access: "read" },
    })).json()) as { data: ResultOf<typeof query> }).data.workshopProjects.nodes;
    assert.deepEqual(await read(), [{ id: project.id, wikiInstallationId: "wiki-install", productRevisionId: revisionId, productRevisionTitle: "SNSP-1 Indoor rev A" }]);
    // Saving without the link clears the columns too.
    const { productRevision: _, ...unlinked } = project;
    const saved = await app.call(`/api/apps/workshop/projects/${project.id}`, member, { method: "PUT", body: unlinked });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await read(), []);
  } finally {
    await app.dispose();
  }
});
