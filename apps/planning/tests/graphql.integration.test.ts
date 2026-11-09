import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { actionPath } from "@ai-outfitter/app-sdk/actions";
import { graphGraphqlResult, serveGraphql } from "@ai-outfitter/app-sdk/app-graphql";
import { documentText, type ResultOf } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { graphql } from "../graph/graphql";
import { documents } from "../src/server/documents";
import { graphqlSchema } from "../src/server/graphql";
import { pullRequests } from "../src/server/project-repositories";
import { issues, projects } from "../src/server/schema";

// The built operational worker serves projects and issues over graph.graphql, the
// call the platform's appGraphql makes (src/lib/app-graphql.ts at the repository root).
const member = { userId: "member", organizationId: "org", role: "member" };
const artifact = () => appArtifact(new URL("..", import.meta.url), "operational");
test("pull request reads use the acting user's authorized repository connection", async () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host = () => ({ call: async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    if (name === "snapshot") return { connections: [
      { id: "personal", provider: "github", owner: "user", operations: ["pulls.list"] },
      { id: "org", provider: "github", owner: "organization", operations: ["pulls.list"] },
    ] };
    if (name === "repository.request") return { id: 42 };
    return { nodes: [{ number: 7, title: "Recent work", url: "https://github.com/acme/web/pull/7", state: "OPEN", createdAt: "2026-11-01", updatedAt: "2026-11-07", closedAt: null, mergedAt: null }], pageInfo: { endCursor: null, hasNextPage: false } };
  } });
  const repo = { nodeId: "repo", title: "web", repository: "acme/web", url: "https://github.com/acme/web", path: null, ref: null };
  const result = await pullRequests({ host, identity: {} } as never, repo, 10, "cursor") as { nodes: { number: number }[] };
  assert.equal(result.nodes[0].number, 7);
  assert.equal(calls[1].input.connectionId, "personal");
  assert.deepEqual(calls[2].input, { connectionId: "personal", resource: "42", operation: "pulls.list", input: { first: 10, after: "cursor" } });
});
test("the acting user's repository GraphQL request returns recent pull requests without an App installation", async () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host = () => ({ call: async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    if (name === "snapshot") return { connections: [{ id: "github:user", provider: "github", owner: "user", operations: ["pulls.list"] }] };
    return { data: { repository: { pullRequests: { nodes: [{ number: 7, title: "Recent work", url: "https://github.com/acme/web/pull/7", state: "OPEN", createdAt: "2026-11-01", updatedAt: "2026-11-07", closedAt: null, mergedAt: null }], pageInfo: { endCursor: null, hasNextPage: false } } } } };
  } });
  const repo = { nodeId: "repo", title: "web", repository: "acme/web", url: "https://github.com/acme/web", path: null, ref: null };
  const result = await pullRequests({ host, identity: {} } as never, repo, 10, "cursor") as { nodes: { number: number }[] };
  assert.equal(result.nodes[0].number, 7);
  assert.equal(calls[1].input.path, "/graphql");
  assert.deepEqual((calls[1].input.body as { variables: unknown }).variables, { owner: "acme", name: "web", first: 10, after: "cursor" });
});
const activeProjects = graphql(`
  query ActiveProjects($active: Boolean, $after: String) {
    projects(first: 2, active: $active, after: $after) {
      nodes { id name githubRepository openIssues updatedAt }
      pageInfo { endCursor hasNextPage }
      aggregate { count }
    }
  }
`);
type Projects = ResultOf<typeof activeProjects>["projects"];

/** Projects a (two open issues), b (one), c (done only), d (none) and one in another installation. */
async function seed(run: (sql: string, values: unknown[]) => Promise<unknown>, installationId: string) {
  const project = (id: string, at: number, installation = installationId) =>
    run("INSERT INTO planning_projects (id, installationId, name, githubRepository, createdBy, updatedBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'seed', 'seed', ?, ?)",
      [id, installation, `Project ${id}`, id === "a" ? "acme/web" : "", at, at]);
  for (const [id, at] of [["a", 3], ["b", 2], ["c", 4], ["d", 5]] as const) await project(id, at);
  await project("other", 6, "another-installation");
  let position = 0;
  const issue = (projectId: string, status: string, installation = installationId, title = "Work") =>
    run("INSERT INTO planning_issues (id, installationId, projectId, title, category, status, position, createdBy, updatedBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'stone', ?, ?, 'seed', 'seed', 1, 1)",
      [`i${position}`, installation, projectId, title, status, position++]);
  for (const [projectId, status] of [["a", "todo"], ["a", "in-progress"], ["a", "done"], ["b", "todo"], ["c", "done"]]) await issue(projectId, status);
  await issue("other", "todo", "another-installation");
  return issue;
}

test("members read active projects with open issue counts over graph.graphql, paged, read-only", async () => {
  const app = await appWorker("planning", artifact(), "planning-graphql");
  try {
    await seed((sql, values) => app.database.prepare(sql).bind(...values).run(), app.installationId);
    const call = (input: Record<string, unknown>, who: typeof member | undefined) =>
      app.call(`${actionPath}/call`, who, { method: "POST", body: { action: "graph.graphql", input, access: "read" } });
    const read = async (variables: Record<string, unknown>) => {
      const response = await call({ query: documentText(activeProjects), variables }, member);
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { data: { projects: Projects } }).data.projects;
    };
    const active = await read({ active: true });
    assert.deepEqual(active.nodes.map(node => [node.id, node.githubRepository, node.openIssues]), [["a", "acme/web", 2], ["b", null, 1]]);
    assert.equal(active.nodes[0].updatedAt, new Date(3).toISOString());
    assert.deepEqual([active.pageInfo.hasNextPage, active.aggregate.count], [false, 2]);
    // Without `active`, every project of this installation, two at a time; never another installation's.
    const all = await read({});
    const rest = await read({ after: all.pageInfo.endCursor });
    assert.deepEqual([...all.nodes, ...rest.nodes].map(node => [node.id, node.openIssues]), [["a", 2], ["b", 1], ["c", 0], ["d", 0]]);
    assert.deepEqual([all.aggregate.count, rest.pageInfo.hasNextPage], [4, false]);
    assert.deepEqual((await read({ active: false })).nodes.map(node => node.id), ["c", "d"]);
    const filtered = await call({ query: `{ issues(status: ["todo"]) { nodes { id projectId } } }` }, member);
    assert.deepEqual(((await filtered.json()) as { data: unknown }).data, { issues: { nodes: [{ id: "i0", projectId: "a" }, { id: "i3", projectId: "b" }] } });
    // Only platform dispatch, with a member's identity, reaches it.
    assert.equal((await call({ query: "{ __typename }" }, undefined)).status, 401);
  } finally {
    await app.dispose();
  }
});

test("a read larger than maxBytes cuts the issue list and says where", async () => {
  const app = await appWorker("planning", artifact(), "planning-graphql-truncated");
  try {
    const issue = await seed((sql, values) => app.database.prepare(sql).bind(...values).run(), app.installationId);
    for (let n = 0; n < 40; n++) await issue("d", "todo", app.installationId, "t".repeat(400));
    const response = await app.call(`${actionPath}/call`, member, {
      method: "POST", body: { action: "graph.graphql", input: { query: `{ issues(projectId: ["d"]) { nodes { id title } pageInfo { hasNextPage } } }`, maxBytes: 8192 }, access: "read" },
    });
    const result = graphGraphqlResult.parse(await response.json());
    const nodes = (result.data as { issues: { nodes: { title: string }[] } }).issues.nodes;
    assert.ok(nodes.length > 0 && nodes.length < 40 && nodes.every(node => node.title.length === 400));
    assert.deepEqual([result.extensions?.truncated, result.extensions?.truncatedPaths], [true, [["issues", "nodes"]]]);
  } finally {
    await app.dispose();
  }
});

test("the project list with open issue counts is one SQL statement", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const statements: string[] = [];
    const db = drizzle(client, { logger: { logQuery: query => statements.push(query) } });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    await seed((sql, args) => client.execute({ sql, args: args as never }), "planning");
    statements.length = 0;
    const result = graphGraphqlResult.parse(await serveGraphql({
      schema: graphqlSchema, query: "{ projects(first: 10, active: true) { nodes { id name githubRepository openIssues } pageInfo { hasNextPage } } }",
      context: { db: () => db, identity: { installationId: "planning" } },
    }));
    assert.deepEqual(result.data, { projects: { nodes: [{ id: "a", name: "Project a", githubRepository: "acme/web", openIssues: 2 }, { id: "b", name: "Project b", githubRepository: null, openIssues: 1 }], pageInfo: { hasNextPage: false } } });
    assert.equal(statements.length, 1, statements.join("\n"));
    assert.match(statements[0], /left join "planning_issues"/);
  } finally {
    client.close();
  }
});

test("legacy repository is exposed without fetching GitHub until pull requests are selected", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    await seed((sql, args) => client.execute({ sql, args: args as never }), "planning");
    await client.execute("UPDATE planning_projects SET githubRepository = 'https://github.com/acme/web' WHERE id = 'a'");
    let githubCalls = 0;
    const host = () => ({ call: async (name: string, input?: { action?: string; input?: unknown }) => {
      if (name === "snapshot" || name === "connector.execute" || name === "repository.request") { githubCalls++; throw new Error("GitHub unavailable"); }
      if (name === "entities.types") return ["graph-type", "graph-node", "graph-edge"].map(type => ({ type, installationId: "wiki", writable: false }));
      if (input?.action === "graph.query") return queryGraph({ version: 1, installationId: "wiki", types: [], nodes: [], edges: [], selection: null, truncated: false, missingTypes: [] } as never, input.input as never);
      return { version: 1, installationId: "wiki", types: [], nodes: [], edges: [], selection: null, truncated: false, missingTypes: [] };
    } });
    const run = (selection: string) => serveGraphql({ schema: graphqlSchema, query: `{ projects(ids:["a"]) { nodes { name repositories(first:10) { nodes { nameWithOwner ${selection} } } } } }`, context: { db: () => db, identity: { installationId: "planning" }, host } });
    const normal = graphGraphqlResult.parse(await run("url"));
    assert.deepEqual(normal.data, { projects: { nodes: [{ name: "Project a", repositories: { nodes: [{ nameWithOwner: "acme/web", url: "https://github.com/acme/web" }] } }] } });
    assert.equal(githubCalls, 0);
    const unavailable = graphGraphqlResult.parse(await run("pullRequests { nodes { number } }"));
    assert.equal(githubCalls, 1);
    assert.ok(unavailable.errors?.length);
    assert.deepEqual(unavailable.data, { projects: { nodes: [{ name: "Project a", repositories: { nodes: [{ nameWithOwner: "acme/web", pullRequests: null }] } }] } });
    const activity = graphGraphqlResult.parse(await run("pullRequestActivity { error pullRequests { nodes { number } } }"));
    assert.equal(activity.errors, undefined);
    assert.deepEqual(activity.data, { projects: { nodes: [{ name: "Project a", repositories: { nodes: [{ nameWithOwner: "acme/web", pullRequestActivity: { error: "GitHub pull requests are unavailable for this repository.", pullRequests: null } }] } }] } });
  } finally { client.close(); }
});


test("published Projects document pages and filters within the caller's installation", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    await seed((sql, args) => client.execute({ sql, args: args as never }), "planning");
    const read = async (variables: Record<string, unknown>) => {
      const result = graphGraphqlResult.parse(await serveGraphql({
        schema: graphqlSchema, query: documentText(documents.Projects.document), variables,
        context: { db: () => db, identity: { installationId: "planning" }, host: () => ({call:async(name:string,input?:{action?:string;input?:unknown})=>{
          if(name === "entities.types") return ["graph-type","graph-node","graph-edge"].map(type=>({type,installationId:"wiki",writable:false}));
          // An empty Wiki answers graph.query with the SDK's own engine, as the Wiki does.
          if(input?.action === "graph.query") return queryGraph({version:1,installationId:"wiki",types:[],nodes:[],edges:[],selection:null,truncated:false,missingTypes:[]} as never, input.input as never);
          return {version:1,installationId:"wiki",types:[],nodes:[],edges:[],selection:null,truncated:false,missingTypes:[]};
        }}) },
      }));
      assert.equal(result.errors, undefined);
      return (result.data as ResultOf<typeof documents.Projects.document>).projects;
    };
    assert.deepEqual((await read({})).nodes.map(node => node.id), ["a", "b", "c", "d"]);
    const first = await read({ first: 1, active: true });
    assert.deepEqual(first.nodes.map(node => [node.id, node.openIssues]), [["a", 2]]);
    assert.equal(first.pageInfo.hasNextPage, true);
    const next = await read({ first: 1, active: true, after: first.pageInfo.endCursor });
    assert.deepEqual(next.nodes.map(node => [node.id, node.openIssues]), [["b", 1]]);
    assert.equal(next.pageInfo.hasNextPage, false);
    assert.deepEqual((await read({ active: false })).nodes.map(node => node.id), ["c", "d"]);
    assert.deepEqual((await read({ ids: ["b", "other"] })).nodes.map(node => node.id), ["b"]);
  } finally {
    client.close();
  }
});
