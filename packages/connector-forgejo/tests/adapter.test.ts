import assert from "node:assert/strict";
import test from "node:test";
import { FORGEJO_DESCRIPTOR, FORGEJO_REQUIRED_SCOPES } from "../src/descriptor";
import {
  ForgejoProviderError,
  ForgejoReadConnector,
  normalizeForgejoOrigin,
} from "../src/adapter";
import { forgejoFixtureTransport } from "../src/fixture";

test("manifest declares the bounded organization-owned repository contract", () => {
  assert.equal(FORGEJO_DESCRIPTOR.contractVersion, "repository.read.v1");
  assert.equal(FORGEJO_DESCRIPTOR.authentication.type, "access-token");
  assert.equal(FORGEJO_DESCRIPTOR.authentication.ownership, "organization");
  assert.deepEqual(FORGEJO_REQUIRED_SCOPES, [
    "read:user",
    "read:repository",
    "read:issue",
  ]);
});

test("uses only official endpoints, token auth, manual pagination and safe URLs", async () => {
  const requests: Request[] = [];
  const connector = new ForgejoReadConnector(
    "https://forge.example.com",
    "fixture-token",
    forgejoFixtureTransport({
      onRequest: (request) => {
        requests.push(request);
      },
    }),
  );
  assert.deepEqual(await connector.authenticatedActor(), {
    id: 42,
    login: "fixture-resident",
  });
  const repository = await connector.verifyRepository({
    owner: "acme",
    repo: "widget",
  });
  assert.equal(repository.url, "https://forge.example.com/acme/widget");
  assert.ok(!JSON.stringify(repository).includes("untrusted.invalid"));
  const issues = await connector.readIssues({
    owner: "acme",
    repo: "widget",
    state: "closed",
    page: 2,
    limit: 10,
  });
  assert.equal(
    issues.items[0].url,
    "https://forge.example.com/acme/widget/issues/12",
  );
  const pulls = await connector.readPullRequests({
    owner: "acme",
    repo: "widget",
    limit: 5,
  });
  assert.equal(
    pulls.items[0].url,
    "https://forge.example.com/acme/widget/pulls/12",
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/v1/user",
      "/api/v1/repos/acme/widget",
      "/api/v1/repos/acme/widget/issues",
      "/api/v1/repos/acme/widget/pulls",
    ],
  );
  assert.equal(new URL(requests[2].url).searchParams.get("type"), "issues");
  assert.equal(new URL(requests[2].url).searchParams.get("page"), "2");
  assert.equal(new URL(requests[2].url).searchParams.get("limit"), "10");
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "token fixture-token");
  }
});

test("rejects unsafe origins, identifiers, redirects, invalid pages and oversize responses", async () => {
  for (const origin of [
    "http://forge.example.com",
    "https://user@forge.example.com",
    "https://forge.example.com/path",
    "https://forge.example.com/?query=1",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
  ])
    assert.throws(() => normalizeForgejoOrigin(origin));
  const noCall = new ForgejoReadConnector(
    "https://forge.example.com",
    "token",
    async () => {
      throw new Error("must not fetch");
    },
  );
  await assert.rejects(
    noCall.verifyRepository({ owner: "../admin", repo: "x" }),
  );
  await assert.rejects(
    noCall.readIssues({ owner: "acme", repo: "widget", page: 0 }),
  );
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.invalid" },
    }),
    new Response("x".repeat(600_000)),
  ]) {
    const connector = new ForgejoReadConnector(
      "https://forge.example.com",
      "token",
      async () => response.clone(),
    );
    await assert.rejects(
      connector.authenticatedActor(),
      (error) => error instanceof ForgejoProviderError,
    );
  }
});

test("provider failures redact credentials and tolerate null pull entries", async () => {
  const rejected = new ForgejoReadConnector(
    "https://forge.example.com",
    "highly-secret-token",
    async () => new Response("highly-secret-token", { status: 401 }),
  );
  await assert.rejects(
    rejected.authenticatedActor(),
    (error) =>
      error instanceof ForgejoProviderError &&
      !error.message.includes("highly-secret-token"),
  );
  const nullable = new ForgejoReadConnector(
    "https://forge.example.com",
    "token",
    async () =>
      Response.json([null, { number: 1, title: "Open", state: "open" }]),
  );
  const result = await nullable.readPullRequests({
    owner: "acme",
    repo: "repo",
  });
  assert.equal(result.items.length, 1);
});
