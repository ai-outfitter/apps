import test from "node:test";
import assert from "node:assert/strict";
import type { GraphQL } from "../src/server/github/graphql";
import { issueCursor, issuesQuery, repositoryIssuePages } from "../src/server/github/issues";

/** GraphQL over fetch, as the host's approved-repository read sends it. */
const t: GraphQL = async (body) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Response("Repository request unavailable", { status: response.status });
  return response.json();
};

const issues = (numbers: number[], endCursor: string | null = null) => ({
  issues: {
    nodes: numbers.map((number) => ({
      number,
      title: `Issue ${number}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    })),
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
  },
});

test("open issues for several repositories are one GraphQL request with variables and per-repository cursors", async () => {
  const original = globalThis.fetch;
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  let respond: () => unknown = () => ({
    data: { r0: issues([1, 2], "Y3Vyc29yOjI="), r1: issues([7]) },
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/graphql");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer t");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(respond());
  };
  try {
    const pages = await repositoryIssuePages(
      t,
      [{ repository: "team/one" }, { repository: "team/two", cursor: "Y3Vyc29yOjE=" }],
      "recent",
    );
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].variables, {
      o0: "team", n0: "one", c0: null,
      o1: "team", n1: "two", c1: "Y3Vyc29yOjE=",
    });
    // Owners, names and cursors never appear in the query text.
    assert.ok(!/team|one|two|Y3Vy/.test(bodies[0].query));
    assert.match(bodies[0].query, /states:OPEN,orderBy:\{field:UPDATED_AT,direction:DESC\}/);
    assert.deepEqual(pages, [
      {
        repository: "team/one",
        issues: [1, 2].map((number) => ({
          number,
          title: `Issue ${number}`,
          url: `https://github.com/team/one/issues/${number}`,
          updatedAt: "2026-01-02T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
        })),
        nextCursor: "Y3Vyc29yOjI=",
      },
      {
        repository: "team/two",
        issues: [{
          number: 7, title: "Issue 7", url: "https://github.com/team/two/issues/7",
          updatedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
        }],
        nextCursor: null,
      },
    ]);
    assert.match(issuesQuery([{ repository: "a/b" }], "oldest").query, /orderBy:\{field:CREATED_AT,direction:ASC\}/);

    // One repository's field error is that repository's error state only.
    respond = () => ({
      data: { r0: null, r1: issues([7]) },
      errors: [{ type: "NOT_FOUND", path: ["r0"] }],
    });
    const partial = await repositoryIssuePages(t, [{ repository: "team/one" }, { repository: "team/two" }], "oldest");
    assert.ok("error" in partial[0]);
    assert.equal(partial[0].repository, "team/one");
    assert.ok("issues" in partial[1] && partial[1].issues.length === 1);

    // A rate limit, or an error about the whole query, fails the read.
    for (const errors of [[{ type: "RATE_LIMITED", path: ["r1"] }], [{ type: "INTERNAL" }]]) {
      respond = () => ({ data: { r0: issues([1]), r1: null }, errors });
      await assert.rejects(
        repositoryIssuePages(t, [{ repository: "team/one" }, { repository: "team/two" }], "recent"),
        (error: unknown) => error instanceof Response && error.status === 503,
      );
    }
    bodies.length = 0;
    assert.deepEqual(await repositoryIssuePages(t, [], "recent"), []);
    assert.equal(bodies.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("issue cursors are GitHub's opaque base64 strings, never query syntax", () => {
  assert.equal(issueCursor.safeParse("Y3Vyc29yOnYyOpK5MjAyNi0x").success, true);
  for (const cursor of ["", "a\"){x}", "a b", "x".repeat(201)])
    assert.equal(issueCursor.safeParse(cursor).success, false, cursor);
});
