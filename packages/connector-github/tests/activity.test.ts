import assert from "node:assert/strict";
import test from "node:test";
import {
  captureGithubActivity,
  githubActivityInput,
  type GithubRead,
} from "../src/index";

const input = {
  repository: "team/repo",
  branch: "main",
  start: "2026-01-01T00:00:00Z",
  end: "2026-02-01T00:00:00Z",
};
const sha = "a".repeat(40);
const pr = (number: number, date: string | null, branch = "main") => ({
  number,
  title: "Synthetic PR",
  html_url: "https://example.test/pr",
  merged_at: date,
  base: { ref: branch },
  head: { sha },
  merge_commit_sha: sha,
});
const commit = (date: string) => ({
  sha,
  html_url: "https://example.test/commit",
  commit: { message: "Synthetic work", committer: { date } },
});
const head = { object: { sha } };

test("period uses merge/committer times and half-open bounds, filters branch, deduplicates", async () => {
  const calls: string[] = [];
  const read: GithubRead = async (path) => {
    calls.push(path);
    if (path.includes("/git/ref/")) return head;
    return path.includes("/pulls?")
      ? [
          pr(1, input.start),
          pr(1, input.start),
          pr(2, input.end),
          pr(3, null),
          pr(4, input.start, "other"),
        ]
      : [commit(input.start), commit(input.start), commit(input.end)];
  };
  const result = await captureGithubActivity(read, input, {
    connectionId: "opaque-provenance",
  });
  assert.equal(result.complete, true);
  assert.equal(result.snapshot.mergedPullRequests.length, 1);
  assert.equal(result.snapshot.commits.length, 1);
  assert.equal(result.provenance.connectionId, "opaque-provenance");
  assert.deepEqual(result.provenance.period, {
    start: input.start,
    end: input.end,
    boundary: "[start,end)",
  });
  assert.ok(calls.every((path) => path.startsWith("/repos/team/repo/")));
  assert.ok(calls.some((path) => path.includes("sha=main&since=")));
});
test("denied reads remain incomplete, with status and no inferred zero activity", async () => {
  const result = await captureGithubActivity(async () => {
    throw new Response("Denied", { status: 403 });
  }, input);
  assert.equal(result.complete, false);
  assert.match(result.errors.join(" "), /HTTP 403/);
  assert.equal("connectionId" in result.provenance, false);
});
test("page caps bound work and never claim complete", async () => {
  let pages = 0;
  const result = await captureGithubActivity(async (path) => {
    if (path.includes("/git/ref/")) return head;
    if (!path.includes("/pulls?")) return [];
    const page = Number(
      new URL("https://example.test" + path).searchParams.get("page"),
    );
    pages++;
    return Array.from({ length: 100 }, (_, index) =>
      pr((page - 1) * 100 + index + 1, input.start),
    );
  }, input);
  assert.equal(pages, 10);
  assert.equal(result.complete, false);
  assert.match(result.errors.join(" "), /pagination limit/);
});
test("cross-page overlaps are deduplicated and reported as pagination drift", async () => {
  const result = await captureGithubActivity(async (path) => {
    if (path.includes("/git/ref/")) return head;
    if (!path.includes("/pulls?")) return [];
    return path.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, i) => pr(i + 1, input.start))
      : [pr(100, input.start)];
  }, input);
  assert.equal(result.complete, false);
  assert.match(result.errors.join(" "), /pagination drift/);
  assert.equal(result.snapshot.mergedPullRequests.length, 100);
});
test("branch head drift and malformed provider data remain explicit incomplete results", async () => {
  let heads = 0;
  const result = await captureGithubActivity(async (path) => {
    if (path.includes("/git/ref/"))
      return { object: { sha: ++heads === 1 ? sha : "b".repeat(40) } };
    return path.includes("/pulls?") ? [{ number: "invalid" }] : [];
  }, input);
  assert.equal(result.complete, false);
  assert.match(result.errors.join(" "), /invalid response/);
  assert.match(result.errors.join(" "), /head changed/);
});
test("unsafe repository/branch and empty periods fail before transport", async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    return [];
  };
  for (const invalid of [
    { ...input, repository: "../repo" },
    { ...input, branch: "../main" },
    { ...input, start: input.end },
    { ...input, end: input.start },
  ]) {
    assert.equal(githubActivityInput.safeParse(invalid).success, false);
    await assert.rejects(captureGithubActivity(read, invalid));
  }
  assert.equal(calls, 0);
});

test("all-state creation ordering retains reopened rows without counting unmerged activity", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    ...pr(index + 1, index === 0 || index === 100 ? input.start : null),
    state: "closed",
  }));
  let pages = 0;
  const result = await captureGithubActivity(async (path) => {
    if (path.includes("/git/ref/")) return head;
    if (!path.includes("/pulls?")) return [];
    const query = new URL("https://example.test" + path).searchParams;
    assert.equal(query.get("state"), "all");
    assert.equal(query.get("sort"), "created");
    assert.equal(query.get("direction"), "asc");
    assert.equal(query.get("per_page"), "100");
    const page = Number(query.get("page"));
    pages++;
    // Reopening a prior page's unmerged PR changes its state, not membership
    // or creation order. A closed-only listing would shift page two's offset.
    if (page === 2) rows[1].state = "open";
    return rows.slice((page - 1) * 100, page * 100);
  }, input);
  assert.equal(result.complete, true);
  assert.equal(pages, 2);
  assert.deepEqual(
    result.snapshot.mergedPullRequests.map((pull) => pull.number),
    [1, 101],
  );
});
