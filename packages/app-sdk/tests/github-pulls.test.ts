import assert from "node:assert/strict";
import test from "node:test";
import { githubPullRequests } from "../src/github-pulls";
const page = { nodes: [], pageInfo: { endCursor: "next", hasNextPage: true } };
for (const id of ["github:user", "personal-account-connection"]) {
  test(`user GitHub grant ${id} uses authorized GraphQL and preserves connection and cursor`, async () => {
    const calls: { operation: string; input: Record<string, any> }[] = [];
    const host = { async call(operation: string, input: Record<string, any>) {
      calls.push({ operation, input });
      if (operation === "snapshot") return { connections: [{ id, provider: "github", owner: "user", operations: ["pulls.list"] }] };
      assert.equal(operation, "repository.request");
      return { data: { repository: { pullRequests: page } } };
    } };
    assert.deepEqual(await githubPullRequests(host, "example/private", 10, "before"), page);
    assert.deepEqual(calls[1].input, { connectionId: id, method: "POST", path: "/graphql", body: {
      query: calls[1].input.body.query, variables: { owner: "example", name: "private", first: 10, after: "before" },
    } });
    assert.equal(calls.length, 2);
  });
}
test("organization GitHub grant still uses scoped repository connector reads", async () => {
  const calls: { operation: string; input: Record<string, any> }[] = [];
  const host = { async call(operation: string, input: Record<string, any>) {
    calls.push({ operation, input });
    if (operation === "snapshot") return { connections: [{ id: "org-grant", provider: "github", owner: "organization", operations: ["pulls.list"] }] };
    return operation === "repository.request" ? { id: 42 } : page;
  } };
  assert.deepEqual(await githubPullRequests(host, "example/shared", 10), page);
  assert.deepEqual(calls[2], { operation: "connector.execute", input: { connectionId: "org-grant", resource: "42", operation: "pulls.list", input: { first: 10, after: null } } });
});
test("provider GraphQL errors remain failures rather than empty activity", async () => {
  const host = { async call(operation: string) { return operation === "snapshot" ? { connections: [{ id: "personal", provider: "github", owner: "user", operations: ["pulls.list"] }] } : { data: { repository: null }, errors: [{ message: "Unavailable" }] }; } };
  await assert.rejects(githubPullRequests(host, "example/private", 10), /unavailable/);
});
