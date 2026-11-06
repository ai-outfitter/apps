import assert from "node:assert/strict";
import test from "node:test";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { documentText, type ResultOf } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { graphql } from "../graph/graphql";

// The built operational worker serves its projects and submitted work over graph.graphql,
// the call the platform's appGraphql makes (src/lib/app-graphql.ts at the repository root).
// The host double answers `snapshot` with the caller's GitHub repositories, as work.get reads them.
const member: Member = { userId: "member", organizationId: "org", role: "member" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
const scope = (userId: string) => ({ organizationId: "org", installationId: "foundry", userId, packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 600_000 });
const repositoriesOf: Record<string, string[]> = { member: ["acme/app", "acme/web"], outsider: [] };
const workflowHost = (hostScope: { userId: string }, calls: string[]) => ({
  async call(operation: string) {
    calls.push(operation);
    if (operation !== "snapshot") return { ok: false as const, status: 403, message: "Not in this fixture" };
    return { ok: true as const, value: {
      installation: { id: "foundry", activeHash: "hash", hostname: null, workflows: [] }, bindings: [], subscriptions: [],
      connections: [{ id: "github", provider: "github", revision: "r", owner: "user", operations: [], repositories: repositoriesOf[hostScope.userId] }],
    } };
  },
});
const insert = async (app: Awaited<ReturnType<typeof appWorker>>, table: string, row: Record<string, unknown>) => {
  await app.database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`)
    .bind(...Object.values(row).map((value) => typeof value === "object" && value ? JSON.stringify(value) : value)).run();
};

const readWork = graphql(`
  query ReadWork($repository: [String!], $ids: [ID!], $after: String) {
    work(first: 2, repository: $repository, ids: $ids, after: $after) {
      nodes { key repository issue createdAt }
      pageInfo { endCursor hasNextPage }
      aggregate { count }
    }
  }
`);
const projectNames = graphql(`
  query ProjectNames { foundryProjects(first: 50) { nodes { id name } pageInfo { hasNextPage } } }
`);

test("members read Foundry work over graph.graphql only for repositories they may read, paged and filtered", async () => {
  const calls: string[] = [];
  const app = await appWorker("software-foundry", artifact(), "foundry", { workflowHost: (hostScope) => workflowHost(hostScope, calls) });
  try {
    const created = Date.UTC(2026, 10, 2, 9);
    for (const [n, repository] of ["acme/app", "acme/secret", "Acme/Web", "acme/app", "acme/app"].entries())
      await insert(app, "work_submissions", { key: `w-${n}`, requestId: `r-${n}`, payloadDigest: "d", repository, createdAt: created + n,
        payload: { title: `Work ${n}`, description: "Private instructions" }, issue: { number: n + 1, url: `https://github.com/${repository}/issues/${n + 1}`, created: true } });
    await insert(app, "foundry_projects", { id: "p-1", name: "Platform", position: 0, repositories: ["acme/app"], milestones: [], createdAt: created, updatedAt: created });
    const call = (userId: string, query: string, variables: Record<string, unknown> = {}) => app.call(`${actionPath}/call`, { ...member, userId }, {
      method: "POST", body: { action: "graph.graphql", input: { query, variables }, access: "read" }, workflowHost: scope(userId),
    });
    const read = async (userId: string, variables: Record<string, unknown> = {}) => {
      const response = await call(userId, documentText(readWork), variables);
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { data: ResultOf<typeof readWork> }).data.work;
    };

    // Projects need no host call: every member reads them, as on the projects page.
    const projects = (await (await call("member", documentText(projectNames))).json()) as { data: ResultOf<typeof projectNames> };
    assert.deepEqual(projects.data.foundryProjects.nodes, [{ id: "p-1", name: "Platform" }]);
    assert.deepEqual(calls, []);

    // acme/secret is not among the member's repositories; Acme/Web matches acme/web.
    const all = await read("member");
    assert.deepEqual([all.nodes.map((node) => node.key), all.aggregate.count, all.pageInfo.hasNextPage], [["w-0", "w-2"], 4, true]);
    assert.deepEqual(all.nodes[0].issue, { number: 1, url: "https://github.com/acme/app/issues/1", created: true });
    assert.equal(all.nodes[0].createdAt, new Date(created).toISOString());
    assert.deepEqual(calls, ["snapshot"]);

    const first = await read("member", { repository: ["acme/app"] });
    assert.deepEqual([first.nodes.map((node) => node.key), first.aggregate.count, first.pageInfo.hasNextPage], [["w-0", "w-3"], 3, true]);
    const next = await read("member", { repository: ["acme/app"], after: first.pageInfo.endCursor });
    assert.deepEqual([next.nodes.map((node) => node.key), next.pageInfo.hasNextPage], [["w-4"], false]);
    assert.deepEqual((await read("member", { ids: ["w-1"] })).aggregate.count, 0);
    // A member with no readable repository reads no work.
    assert.deepEqual((await read("outsider")).nodes, []);

    // The submitted payload is not part of the schema: asking for it fails validation.
    const hidden = (await (await call("member", "{ work { nodes { key payload } } }")).json()) as { data: unknown; errors: { message: string }[] };
    assert.equal(hidden.data, null);
    assert.match(hidden.errors[0].message, /Cannot query field "payload" on type "Work"/);

    // Only platform dispatch, with a member's identity, reaches it.
    assert.equal((await app.call(`${actionPath}/call`, undefined, { method: "POST", body: { action: "graph.graphql", input: { query: "{ __typename }" } } })).status, 401);
  } finally {
    await app.dispose();
  }
});
