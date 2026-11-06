import assert from "node:assert/strict";
import test from "node:test";
import {
  answered,
  issueRuns,
  MILESTONE_ITEM_LIMIT,
  milestoneItems,
  milestonesQuery,
  projectMilestonesQuery,
  readMilestones,
  readProjectMilestones,
} from "../src/server/github/milestones";
import type { GraphQL } from "../src/server/github/graphql";

/** GraphQL over fetch, as the host's approved-repository read sends it. */
const t: GraphQL = async (body) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Response("Repository request unavailable", { status: response.status });
  return response.json();
};

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
const issue = (number: number, created: number, state: "OPEN" | "CLOSED" = "OPEN") => ({
  number,
  title: `Item ${number}`,
  state,
  createdAt: day(created),
  updatedAt: day(created + 1),
});
const pull = (
  number: number,
  created: number,
  state: "OPEN" | "CLOSED" | "MERGED" = "OPEN",
  isDraft = false,
) => ({ ...issue(number, created), state, isDraft });
const page = <T>(nodes: T[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const milestone = {
  number: 3,
  title: "Goal",
  description: null,
  state: "OPEN",
  openIssueCount: 2,
  closedIssueCount: 1,
  dueOn: null,
  updatedAt: "2026-10-01T00:00:00Z",
};

test("milestone items merge oldest first, keep GitHub's states and drafts, and list each kind open first", () => {
  const { issues, pullRequests, truncated } = milestoneItems(
    "team/repo",
    page([issue(9, 1, "CLOSED"), issue(4, 2)]),
    page([pull(5, 3, "MERGED"), pull(6, 4, "CLOSED"), pull(7, 5, "OPEN", true)]),
  );
  assert.deepEqual(
    issues.map((item) => [item.number, item.state, item.url]),
    [
      [4, "open", "https://github.com/team/repo/issues/4"],
      [9, "closed", "https://github.com/team/repo/issues/9"],
    ],
  );
  assert.deepEqual(
    pullRequests.map((item) => [item.number, item.state, item.draft, item.url]),
    [
      [7, "open", true, "https://github.com/team/repo/pull/7"],
      [5, "merged", false, "https://github.com/team/repo/pull/5"],
      [6, "closed", false, "https://github.com/team/repo/pull/6"],
    ],
  );
  assert.equal(truncated, false);
});

test("milestone items are one oldest-first prefix: a connection with more pages cuts newer items", () => {
  // Issues stop at day 10 with more to come; pull requests run to day 20.
  // A pull request from day 15 could be newer than unread issues, so it and
  // anything after day 10 is cut, and the result is truncated.
  const { issues, pullRequests, truncated } = milestoneItems(
    "team/repo",
    page([issue(1, 1), issue(2, 10)], true),
    page([pull(3, 5), pull(4, 15), pull(5, 20)]),
  );
  assert.deepEqual(issues.map((item) => item.number), [1, 2]);
  assert.deepEqual(pullRequests.map((item) => item.number), [3]);
  assert.equal(truncated, true);
  // Without pull request access only issues count.
  const onlyIssues = milestoneItems("team/repo", page([issue(1, 1)]), undefined);
  assert.deepEqual(onlyIssues.pullRequests, []);
  assert.equal(onlyIssues.truncated, false);
  // More than the item limit is capped and reported.
  const many = Array.from({ length: MILESTONE_ITEM_LIMIT + 1 }, (_, index) => issue(index + 1, index));
  const capped = milestoneItems("team/repo", page(many), undefined);
  assert.equal(capped.issues.length, MILESTONE_ITEM_LIMIT);
  assert.equal(capped.truncated, true);
});

test("the milestone list and one milestone's issues and pull requests are one GraphQL request", async () => {
  const original = globalThis.fetch;
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  let respond: () => unknown = () => ({
    data: {
      repository: {
        milestones: page([milestone], true),
        milestone: {
          ...milestone,
          issues: page([issue(1, 1), issue(2, 2, "CLOSED")]),
          pullRequests: page([pull(3, 3, "OPEN", true)]),
        },
      },
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/graphql");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer t");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(respond());
  };
  try {
    const both = await readMilestones(t, "team/repo", { state: "closed", number: 3, pullRequests: true });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].variables, { owner: "team", name: "repo", states: ["CLOSED"], number: 3 });
    // Values are variables; the query text never contains them.
    assert.ok(!/team|repo"|CLOSED\]/.test(bodies[0].query));
    const list = answered(both.list);
    assert.equal(list.truncated, true);
    assert.equal(list.milestones[0].url, "https://github.com/team/repo/milestone/3");
    assert.deepEqual([list.milestones[0].openItems, list.milestones[0].closedItems], [2, 1]);
    const detail = answered(both.detail);
    assert.deepEqual(detail.issues.map((item) => [item.number, item.state]), [[1, "open"], [2, "closed"]]);
    assert.deepEqual(detail.pullRequests.map((item) => [item.number, item.draft]), [[3, true]]);
    assert.equal(detail.pullRequestsListed, true);
    assert.equal(detail.truncated, false);

    // Without Pull requests read the connection is not requested at all.
    assert.ok(!milestonesQuery({ number: 3, pullRequests: false }).includes("pullRequests"));
    assert.ok(!milestonesQuery({ state: "open", pullRequests: true }).includes("milestone("));
    respond = () => ({
      data: { repository: { milestone: { ...milestone, issues: page([issue(1, 1)]) } } },
    });
    const issuesOnly = answered((await readMilestones(t, "team/repo", { number: 3, pullRequests: false })).detail);
    assert.equal(issuesOnly.pullRequestsListed, false);

    // A milestone GitHub does not return is a 403, as with REST; the list in
    // the same request is still answered.
    respond = () => ({ data: { repository: { milestones: page([milestone]), milestone: null } } });
    const missing = await readMilestones(t, "team/repo", { state: "open", number: 4, pullRequests: true });
    assert.equal(answered(missing.list).milestones.length, 1);
    assert.ok(missing.detail instanceof Response && missing.detail.status === 403);
    assert.throws(() => answered(missing.detail), (error: unknown) => error instanceof Response && error.status === 403);
    // An error at the list's path fails only the list.
    respond = () => ({
      data: { repository: { milestones: null, milestone: { ...milestone, issues: page([]), pullRequests: page([]) } } },
      errors: [{ type: "INTERNAL", path: ["repository", "milestones"] }],
    });
    const partial = await readMilestones(t, "team/repo", { state: "open", number: 3, pullRequests: true });
    assert.ok(partial.list instanceof Response && partial.list.status === 503);
    assert.equal(answered(partial.detail).milestone.number, 3);
    // A rate limit or an unknown repository fails the whole read.
    respond = () => ({ data: { repository: null }, errors: [{ type: "RATE_LIMITED" }] });
    await assert.rejects(
      readMilestones(t, "team/repo", { state: "open", pullRequests: true }),
      (error: unknown) => error instanceof Response && error.status === 503,
    );
    respond = () => ({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] });
    await assert.rejects(
      readMilestones(t, "team/repo", { state: "open", pullRequests: true }),
      (error: unknown) => error instanceof Response && error.status === 403,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a milestone with more than one page of issues or pull requests reads up to three pages of each, in sequence", async () => {
  const original = globalThis.fetch;
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const more = <T>(nodes: T[], endCursor: string) => ({ nodes, pageInfo: { hasNextPage: true, endCursor } });
  const issues = (from: number) => Array.from({ length: 100 }, (_, index) => issue(from + index, from + index));
  const responses: unknown[] = [
    { data: { repository: { milestone: { ...milestone, issues: more(issues(1), "aQ=="), pullRequests: page([pull(900, 0)]) } } } },
    { data: { repository: { milestone: { issues: more(issues(101), "aR==") } } } },
    { data: { repository: { milestone: { issues: more(issues(201), "aS==") } } } },
  ];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(responses[bodies.length - 1]);
  };
  try {
    const detail = answered((await readMilestones(t, "team/repo", { number: 3, pullRequests: true })).detail);
    // The first query, then two more pages of issues only; the complete pull
    // request connection is not asked for again.
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[1].variables, { owner: "team", name: "repo", number: 3, issues: "aQ==" });
    assert.deepEqual(bodies[2].variables, { owner: "team", name: "repo", number: 3, issues: "aR==" });
    assert.ok(bodies[1].query.includes("after:$issues") && !bodies[1].query.includes("pullRequests"));
    assert.equal(detail.issues.length + detail.pullRequests.length, MILESTONE_ITEM_LIMIT);
    assert.equal(detail.truncated, true);

    // A later page GitHub does not answer keeps what was read, truncated.
    bodies.length = 0;
    responses[1] = { data: null, errors: [{ type: "RATE_LIMITED" }] };
    const partial = answered((await readMilestones(t, "team/repo", { number: 3, pullRequests: true })).detail);
    assert.equal(bodies.length, 2);
    assert.equal(partial.issues.length, 100);
    assert.equal(partial.truncated, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("recorded runs attach only to their own repository and issue, newest first", () => {
  const row = (
    id: string,
    updatedAt: number,
    repository: unknown,
    issue: unknown,
    status: string,
    title: unknown = id,
  ) => ({ id, title, repository, issue, status, updatedAt });
  const runs = issueRuns("team/repo", [1, 2], [
    row("old", 1, "team/repo", 1, "running"),
    row("new", 5, "Team/Repo", 1, "complete"),
    row("mid", 3, "team/repo", 1, "failed", null),
    row("capped", 0, "team/repo", 1, "running"),
    row("other-repo", 9, "team/other", 2, "running"),
    row("other-issue", 9, "team/repo", 7, "running"),
    row("string-issue", 9, "team/repo", "2", "running"),
    row("fractional-issue", 9, "team/repo", 1.5, "running"),
  ]);
  assert.deepEqual(
    runs.get(1)?.map((run) => [run.id, run.title, run.status]),
    [
      ["new", "new", "completed"],
      ["mid", "#1", "failed"],
      ["old", "old", "running"],
    ],
  );
  assert.equal(runs.has(2), false);
});

test("milestone pull requests carry their branches and the issues they close", () => {
  const { pullRequests } = milestoneItems(
    "team/repo",
    page([issue(4, 1)]),
    page([
      {
        ...pull(5, 2),
        baseRefName: "main",
        headRefName: "fix-4",
        closingIssuesReferences: { nodes: [{ number: 4 }, null] },
      },
      pull(6, 3),
    ]),
  );
  assert.deepEqual(
    pullRequests.map((item) => [item.number, item.base, item.head, item.closes]),
    [
      [5, "main", "fix-4", [4]],
      [6, null, null, []],
    ],
  );
  assert.match(
    milestonesQuery({ number: 3, pullRequests: true }),
    /baseRefName headRefName closingIssuesReferences\(first:10\)\{nodes\{number\}\}/,
  );
});

test("the dashboard reads every project's open milestones in one query, failing projects alone", async () => {
  const original = globalThis.fetch;
  const bodies: { query: string; variables: Record<string, string> }[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      data: {
        r0: { milestones: { nodes: [milestone, null] } },
        r1: null,
        r2: { milestones: { nodes: [] } },
      },
      errors: [{ type: "NOT_FOUND", path: ["r1"] }],
    });
  };
  try {
    const result = await readProjectMilestones(t, ["team/one", "team/gone", "team/empty"]);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].variables, {
      o0: "team", n0: "one", o1: "team", n1: "gone", o2: "team", n2: "empty",
    });
    assert.equal(bodies[0].query, projectMilestonesQuery(3));
    assert.match(bodies[0].query, /r2:repository\(owner:\$o2,name:\$n2\)\{milestones\(first:50,states:\[OPEN\]/);
    assert.deepEqual(
      result.projects.map((project) => [project.repository, project.milestones.map((item) => item.number), "error" in project]),
      [
        ["team/one", [3], false],
        ["team/gone", [], true],
        ["team/empty", [], false],
      ],
    );
    assert.equal(result.truncated, false);
    assert.deepEqual(await readProjectMilestones(t, []), { projects: [], truncated: false });
    assert.equal(bodies.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
