import assert from "node:assert/strict";
import test from "node:test";
import { githubRepositoryName, projectRepositories } from "../src/project-readiness";
import { LOOKBACK_DAYS, summarizeCommits, windowStart } from "../src/server/repo-changes";

const DAY = 24 * 60 * 60 * 1000;
const record = (id: string, attributes: Record<string, unknown>, title = id, references: unknown[] = []) =>
  ({ ref: { installationId: "wiki", type: "node", id }, revision: 1, title, attributes, references }) as never;
const types = [
  record("t-project", { name: "Project" }), record("t-repo", { name: "Repository" }),
  record("t-source", { name: "source_in" }), record("t-uses", { name: "uses" }),
];
const graph = {
  types,
  nodes: [
    record("project", { typeId: "t-project" }, "Planning", [{ installationId: "planning", type: "project", id: "p1" }]),
    record("webapp", { typeId: "t-repo", website: "https://github.com/ai-outfitter/webapp" }, "webapp"),
    record("docs", { typeId: "t-repo", website: "https://gitlab.com/example/docs" }, "docs"),
    record("sdk", { typeId: "t-repo", website: "https://github.com/ai-outfitter/sdk.git" }, "sdk"),
  ],
  edges: [
    record("e1", { typeId: "t-source", fromId: "project", toId: "webapp", properties: { path: "/catalog/apps/planning/", ref: "main" } }),
    record("e2", { typeId: "t-source", fromId: "project", toId: "docs" }),
    record("e3", { typeId: "t-uses", fromId: "project", toId: "sdk" }),
  ],
};

test("a project's GitHub repositories come from its Wiki node's source_in edges, with path and ref", () => {
  assert.deepEqual(projectRepositories(graph, "planning", "p1"), [
    { nodeId: "webapp", edgeId: "e1", title: "webapp", repository: "ai-outfitter/webapp", url: "https://github.com/ai-outfitter/webapp", path: "catalog/apps/planning", ref: "main" },
  ]);
  assert.deepEqual(projectRepositories(graph, "planning", "other"), [], "an unlinked project has none");
  assert.equal(githubRepositoryName("https://github.com/Org/Repo.git"), "org/repo");
  assert.equal(githubRepositoryName("https://github.com/org"), null);
});

test("the window is since the previous digest when it ran within the lookback, otherwise the lookback", () => {
  const now = Date.UTC(2026, 10, 6);
  assert.equal(windowStart(now - DAY, now), now - DAY);
  assert.equal(windowStart(now - 30 * DAY, now), now - LOOKBACK_DAYS * DAY);
  assert.equal(windowStart(null, now, 3), now - 3 * DAY);
});

test("commits are grouped by the pull request that merged them; the rest are direct pushes", () => {
  const commit = (sha: string, pulls: number[]) => ({
    sha: sha.repeat(40), headline: `Commit ${sha}`, committedAt: "2026-11-05T12:00:00Z", url: `https://github.com/o/r/commit/${sha}`, author: "ada",
    pullRequests: pulls.map((number) => ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt: `2026-11-0${number}T00:00:00Z`, author: "ada" })),
  });
  const result = summarizeCommits({ nodeId: "n", title: "r", repository: "o/r", url: "https://github.com/o/r", path: null, ref: null },
    { ref: "main", commits: [commit("a", [5]), commit("b", [5]), commit("c", [3]), commit("d", [])], more: true });
  assert.deepEqual(result.pullRequests.map((pull) => [pull.number, pull.commits]), [[5, 2], [3, 1]]);
  assert.deepEqual(result.directCommits.map((item) => item.headline), ["Commit d"]);
  assert.equal(result.commitCount, 4);
  assert.equal(result.ref, "main");
  assert.equal(result.more, true);
});

test("each linked repository is read through the organization's GitHub connection, or reports why not", async () => {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  let denied = false;
  const host = {
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === "snapshot")
        return { connections: [{ id: "personal", provider: "github", owner: "user", operations: ["commits.list"] }, { id: "org-github", provider: "github", owner: "organization", operations: ["commits.list"] }] };
      if (operation === "repository.request") return { id: 30, full_name: "ai-outfitter/webapp" };
      if (operation === "connector.execute") {
        if (denied) throw new Response("Editors only", { status: 403 });
        return { ref: "main", more: false, commits: [{ sha: "a".repeat(40), headline: "Add digests", committedAt: "2026-11-05T12:00:00Z", url: "https://github.com/ai-outfitter/webapp/commit/a", author: "ada", pullRequests: [] }] };
      }
      throw new Error(`Unexpected ${operation}`);
    },
  } as never;
  const since = Date.UTC(2026, 10, 1), until = Date.UTC(2026, 10, 6);
  const [read] = await (await import("../src/server/repo-changes")).projectRepositoryChanges(host, "planning", "p1", since, until, async () => graph);
  assert.equal(read.error, null);
  assert.equal(read.commitCount, 1);
  const execute = calls.find((call) => call.operation === "connector.execute");
  assert.deepEqual(execute?.input, { connectionId: "org-github", resource: "30", operation: "commits.list",
    input: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-06T00:00:00.000Z", limit: 100, ref: "main", path: "catalog/apps/planning" } });
  denied = true;
  const [refused] = await (await import("../src/server/repo-changes")).projectRepositoryChanges(host, "planning", "p1", since, until, async () => graph);
  assert.equal(refused.error, "Editors only");
  assert.equal(refused.commitCount, 0);
});
