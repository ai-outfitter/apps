import assert from "node:assert/strict";
import test from "node:test";
import { changeArea, changeKind, readChanges } from "../src/server/github/changes";
import type { GraphQL } from "../src/server/github/graphql";
import { documents, runDocument } from "../src/server/documents";
import type { FoundryContext } from "../src/server/graphql";

type Pull = { number: number; mergedAt: string; title?: string; files?: string[] };
const node = ({ number, mergedAt, title = `Change ${number}`, files = [] }: Pull) => ({
  number, title, url: `https://github.com/x/${number}`, mergedAt,
  author: { login: "dev" }, mergeCommit: { oid: `sha${number}` }, files: { nodes: files.map((path) => ({ path })) },
});
const page = (pulls: Pull[], endCursor: string | null = null) => ({
  nodes: pulls.map(node), pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const since = "2026-11-02T00:00:00Z", until = "2026-11-03T00:00:00Z";

test("a change's kind comes from a Conventional Commits prefix, and its areas from monorepo paths", () => {
  assert.equal(changeKind("feat(crm): pipeline"), "feature");
  assert.equal(changeKind("fix: login loop"), "fix");
  assert.equal(changeKind("refactor!: move chat"), "maintenance");
  assert.equal(changeKind("Planning shows evidence screenshots (#703)"), null);
  assert.equal(changeKind("Hotfix: login loop"), null);
  assert.deepEqual(
    ["catalog/apps/crm/src/a.ts", "packages/app-sdk/src/x.ts", "docs/plans/a.md", "README.md", "src/apps/b.ts", "catalog/apps/README.md"].map(changeArea),
    ["catalog/apps/crm", "packages/app-sdk", "docs", ".", "src", "catalog"],
  );
});

test("merged pull requests in the window come from one search per repository, paged, deduplicated and newest first", async () => {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const answers = [
    // r1's repository is gone; a nested error elsewhere does not fail r0.
    { data: { r0: page([
      { number: 8, mergedAt: "2026-11-02T12:00:00Z", title: "feat: x", files: ["catalog/apps/crm/a.ts", "docs/a.md"] },
      { number: 9, mergedAt: until }, // at `until`: the next window's
    ], "c1"), r1: null }, errors: [{ type: "NOT_FOUND", path: ["r1"] }, { type: "FORBIDDEN", path: ["r0", "nodes", 0, "author"] }] },
    { data: { r0: page([{ number: 7, mergedAt: "2026-11-02T03:00:00Z" }, { number: 8, mergedAt: "2026-11-02T12:00:00Z", title: "feat: x", files: ["catalog/apps/crm/a.ts", "docs/a.md"] }]) } },
  ];
  const graphql: GraphQL = async (body) => { bodies.push(body as never); return answers.shift(); };
  const read = await readChanges(graphql, ["acme/app", "acme/gone"], since, until);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].variables, {
    q0: `repo:acme/app is:pr is:merged merged:${since}..${until}`, c0: null,
    q1: `repo:acme/gone is:pr is:merged merged:${since}..${until}`, c1: null,
  });
  assert.deepEqual(bodies[1].variables, { q0: `repo:acme/app is:pr is:merged merged:${since}..${until}`, c0: "c1" });
  assert.ok(!/acme|app|gone/.test(bodies[0].query));
  assert.deepEqual(read, {
    changes: [
      { repository: "acme/app", number: 8, title: "feat: x", url: "https://github.com/x/8", mergedAt: "2026-11-02T12:00:00Z", author: "dev", mergeCommit: "sha8", kind: "feature", areas: ["catalog/apps/crm", "docs"] },
      { repository: "acme/app", number: 7, title: "Change 7", url: "https://github.com/x/7", mergedAt: "2026-11-02T03:00:00Z", author: "dev", mergeCommit: "sha7", kind: null, areas: [] },
    ],
    failed: ["acme/gone"],
    complete: true,
  });
});

test("a repository with more than five pages of merges stops and says the read is incomplete", async () => {
  let calls = 0;
  const graphql: GraphQL = async () => {
    calls++;
    return { data: { r0: page([{ number: calls, mergedAt: "2026-11-02T10:00:00Z" }], `c${calls}`) } };
  };
  const read = await readChanges(graphql, ["acme/app"], since, until);
  assert.equal(calls, 5);
  assert.equal(read.changes.length, 5);
  assert.equal(read.complete, false);
});

test("a rate limit fails the read rather than returning a partial answer", async () => {
  const graphql: GraphQL = async () => ({ data: null, errors: [{ type: "RATE_LIMITED", path: ["r0"] }] });
  await assert.rejects(readChanges(graphql, ["acme/app"], since, until), (error) => error instanceof Response && error.status === 503);
});

test("DailyShipped reads only repositories the caller's GitHub connection may read, within 31 days", async () => {
  const requests: unknown[] = [];
  const context = {
    identity: { userId: "u1", owner: { kind: "user", id: "u1" }, installationId: "foundry", role: "member", canEdit: false },
    host: () => ({
      async call(operation: string, input: { body?: unknown }) {
        if (operation === "snapshot") return { connections: [{ id: "gh", provider: "github", repositories: ["acme/app", "acme/web"] }] };
        requests.push(input.body);
        return { data: { r0: page([{ number: 1, mergedAt: "2026-11-02T10:00:00Z" }]), r1: page([]) } };
      },
    }),
  } as unknown as FoundryContext;
  const daily = { since, until };

  const shipped = await runDocument(documents.DailyShipped.document, daily, context);
  assert.deepEqual(shipped.changes.changes.map((change) => [change.repository, change.number]), [["acme/app", 1]]);
  assert.deepEqual([shipped.changes.failed, shipped.changes.complete], [[], true]);
  // By default every readable repository is asked, in one request.
  assert.equal(requests.length, 1);

  const refused = (status: number) => (error: unknown) => error instanceof Response && error.status === status;
  await assert.rejects(runDocument(documents.DailyShipped.document, { ...daily, repositories: ["acme/secret"] }, context), refused(403));
  await assert.rejects(runDocument(documents.DailyShipped.document, { since: "2026-09-01T00:00:00Z", until: daily.until }, context), refused(400));
  await assert.rejects(runDocument(documents.DailyShipped.document, { since: daily.until, until: daily.since }, context), refused(400));
  // Without an offset the window would move with the server's time zone.
  await assert.rejects(runDocument(documents.DailyShipped.document, { since: "2026-11-02T00:00:00", until }, context), refused(400));
  assert.equal(requests.length, 1);
});
