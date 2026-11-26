import assert from "node:assert/strict";
import test from "node:test";
import { forgejoApiBase, forgejoRepositoryToken, normalizeForgejoOrigin } from "../src/index";

const configured = () => ({ origin: "http://127.0.0.1:3000", token: "f".repeat(40), botUserId: 3 });

test("the API base sits under the origin", () => {
  assert.equal(forgejoApiBase(configured()), "http://127.0.0.1:3000/api/v1");
});

test("an origin on this machine needs the operator's loopback approval", () => {
  assert.throws(() => normalizeForgejoOrigin("http://127.0.0.1:3000"), (error: Response) => error.status === 400);
  assert.equal(normalizeForgejoOrigin("http://127.0.0.1:3000", true), "http://127.0.0.1:3000");
  assert.equal(normalizeForgejoOrigin("https://forgejo.example"), "https://forgejo.example");
  // Loopback approval admits only this machine, and never a path or another address.
  assert.throws(() => normalizeForgejoOrigin("http://forgejo.example", true), (error: Response) => error.status === 400);
  assert.throws(() => normalizeForgejoOrigin("http://10.0.0.2:3000", true), (error: Response) => error.status === 400);
  assert.throws(() => normalizeForgejoOrigin("http://127.0.0.1:3000/api", true), (error: Response) => error.status === 400);
});

function transport(repo: Record<string, unknown>, status = 200) {
  const seen: Request[] = [];
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response(JSON.stringify(repo), { status });
    },
  };
}
const repo = (permissions: Record<string, boolean>) => ({ id: 7, full_name: "box/repo", owner: { id: 2 }, permissions: { admin: false, ...permissions } });

test("returns repository authority when the bot has the permission asked for", async () => {
  const config = configured();
  const { seen, fetch } = transport(repo({ push: true, pull: true }));
  const granted = await forgejoRepositoryToken("Box/Repo", config, { contents: "write" }, 7, fetch);
  assert.equal(seen[0].url, "http://127.0.0.1:3000/api/v1/repos/box/repo");
  assert.equal(seen[0].headers.get("authorization"), `token ${"f".repeat(40)}`);
  assert.equal(granted.path, "/repos/box/repo");
  assert.equal(granted.forge, "forgejo");
  assert.equal(granted.botUserId, 3);
  assert.deepEqual(granted.executionIdentity, { provider: "forgejo", kind: "bot", installationId: 2, appId: 3 });
});

test("refuses missing write permission, another repository id, and bad names", async () => {
  const config = configured();
  await assert.rejects(forgejoRepositoryToken("box/repo", config, { contents: "write" }, 7, transport(repo({ push: false, pull: true })).fetch),
    (error: Response) => error.status === 403);
  await assert.rejects(forgejoRepositoryToken("box/repo", config, { contents: "read" }, 8, transport(repo({ push: false, pull: true })).fetch),
    (error: Response) => error.status === 403);
  await assert.rejects(forgejoRepositoryToken("box/repo", config, { contents: "read" }, undefined, transport({}, 404).fetch),
    (error: Response) => error.status === 404);
  await assert.rejects(forgejoRepositoryToken("box/..", config, { contents: "read" }));
});
