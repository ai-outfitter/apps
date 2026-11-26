import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { executeForgejoOperation } from "../src/operations";

const token = "a".repeat(40);
const config = { origin: "http://127.0.0.1:3300", token, botUserId: 2 };

/** A Forgejo stand-in over global fetch: issues and comments for box/repo. */
function forgejo(t: test.TestContext) {
  const issues: { number: number; title: string; body: string; html_url: string; state: string; user: { id: number }; pull_request: null }[] = [];
  const comments: { id: number; body: string; html_url: string }[] = [];
  const calls: string[] = [];
  const original = globalThis.fetch;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one route per Forgejo call the module makes
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    assert.equal(new Headers(init?.headers).get("authorization"), `token ${token}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/repos/box/repo") return json({ id: 7, full_name: "box/repo" });
    if (path === "/repos/box/other") return json({ message: "not found" }, 404);
    if (path === "/repos/box/repo/issues" && method === "GET") return json([...issues].reverse());
    if (path === "/repos/box/repo/issues" && method === "POST") {
      const issue = { number: issues.length + 1, title: body.title, body: body.body, html_url: `i${issues.length + 1}`, state: "open", user: { id: 2 }, pull_request: null };
      issues.push(issue);
      return json(issue, 201);
    }
    if (path === "/repos/box/repo/issues/1") return json(issues[0]);
    if (path === "/repos/box/repo/issues/1/comments" && method === "GET") return json(comments);
    if (path === "/repos/box/repo/issues/1/comments" && method === "POST") {
      const comment = { id: comments.length + 10, body: body.body, html_url: `c${comments.length + 10}` };
      comments.push(comment);
      return json(comment, 201);
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return { issues, comments, calls };
}

test("issue create and comment are idempotent by request marker", async (t) => {
  const stub = forgejo(t);
  
  const create = { title: "Add subtract", body: "Please.", marker: "request:ABCDEF12" };
  const first = await executeForgejoOperation(config, covered, "issues.create", create);
  const again = await executeForgejoOperation(config, covered, "issues.create", create);
  assert.deepEqual(first, { number: 1, url: "i1", state: "open", created: true });
  assert.deepEqual(again, { number: 1, url: "i1", state: "open", created: false });
  assert.equal(stub.issues.length, 1);
  assert.match(stub.issues[0].body, /<!-- outfitter-request:request:abcdef12 -->$/);

  const note = { number: 1, body: "Run started.", marker: "comment:ABCDEF12" };
  const posted = await executeForgejoOperation(config, covered, "issues.comment", note);
  const repeated = await executeForgejoOperation(config, covered, "issues.comment", note);
  assert.ok(posted && typeof posted === "object" && "created" in posted && posted.created === true);
  assert.ok(repeated && typeof repeated === "object" && "created" in repeated && repeated.created === false);
  assert.equal(stub.comments.length, 1);
  await assert.rejects(executeForgejoOperation(config, covered, "pulls.create", {}), (error: Response) => error.status === 403);
  await assert.rejects(executeForgejoOperation(config, covered, "issues.create", { title: "", body: "", marker: "x" }));
});

const covered = { id: 7, name: "box/repo" };
const repoPath = "/api/v1/repos/box/repo";
type ReadFixture = (url: URL) => Response;

function mockReads(t: test.TestContext, read: ReadFixture) {
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), `token ${token}`);
    return read(url);
  });
  return calls;
}

const status = (code: number) => (error: unknown) => error instanceof Response && error.status === code;
const sha = (char: string) => char.repeat(40);

test("repository evidence reads tracked text and directories at one immutable commit", async (t) => {
  const object = (path: string, char: string, mode = "100644") => ({ path, sha: sha(char), mode });
  const directory = (char: string, tree: unknown[], truncated = false) => ({ sha: sha(char), tree, truncated });
  const file = (char: string, text: string) => ({ sha: sha(char), encoding: "base64", content: btoa(text) });
  const fixtures = new Map<string, unknown>([
    ["", { id: 7, full_name: "box/repo", default_branch: "release/current" }],
    ["/branches/release/current", { name: "release/current", commit: { id: sha("a") } }],
    [`/git/commits/${sha("a")}?stat=false&verification=false&files=false`, { sha: sha("a"), commit: { tree: { sha: sha("b") } } }],
    [`/git/trees/${sha("b")}?page=1&per_page=64`, directory("b", [
      object("README.md", "c"), object("src", "d", "040000"), object(".github", "d", "040000"),
      object(".forgejo", "e", "040000"), object(".env", "f"),
    ], true)],
    [`/git/trees/${sha("d")}?page=1&per_page=64`, directory("d", [object("ISSUE_TEMPLATE", "f", "040000")])],
    [`/git/trees/${sha("e")}?page=1&per_page=64`, directory("e", [object("ISSUE_TEMPLATE", "1", "040000")])],
    [`/git/trees/${sha("f")}?page=1&per_page=64`, directory("f", [
      object("Bug report.yml", "2"), object("config.yml", "3"), object("link.md", "4", "120000"),
    ])],
    [`/git/trees/${sha("1")}?page=1&per_page=64`, directory("1", [
      object("feature.md", "5"), object("big.yaml", "6"), object("binary.yml", "7"),
    ])],
    [`/git/blobs/${sha("c")}`, file("c", "README body")],
    [`/git/blobs/${sha("2")}`, file("2", "name: Bug\nbody: []\n")],
    [`/git/blobs/${sha("5")}`, file("5", "# Feature\n")],
    [`/git/blobs/${sha("6")}`, file("6", "a".repeat(25_000))],
    [`/git/blobs/${sha("7")}`, file("7", "\x00binary")],
  ]);
  const calls = mockReads(t, (url) => {
    assert.equal(url.origin, "http://127.0.0.1:3300");
    assert.ok(url.pathname.startsWith(repoPath));
    const path = url.pathname.slice(repoPath.length) + url.search;
    assert.ok(fixtures.has(path), path);
    return Response.json(fixtures.get(path));
  });
  
  const evidence = z.object({
    defaultBranch: z.string(), commitSha: z.string(), commitUrl: z.string(), truncated: z.boolean(),
    tree: z.array(z.object({path: z.string(), kind: z.string()})),
    files: z.array(z.object({path: z.string(), kind: z.string(), text: z.string(), url: z.string()})),
  }).parse(await executeForgejoOperation(config, covered, "repositories.evidence.read", {}));
  assert.equal(evidence.defaultBranch, "release/current");
  assert.equal(evidence.commitSha, sha("a"));
  assert.equal(evidence.commitUrl, `${config.origin}/box/repo/commit/${sha("a")}`);
  assert.ok(evidence.tree.some(({ path, kind }) => path === "src" && kind === "directory"));
  assert.deepEqual(evidence.files.map(({ path, kind, text }) => [path, kind, text]), [
    ["README.md", "readme", "README body"],
    [".github/ISSUE_TEMPLATE/Bug report.yml", "issue-template", "name: Bug\nbody: []\n"],
    [".forgejo/ISSUE_TEMPLATE/feature.md", "issue-template", "# Feature\n"],
  ]);
  assert.match(evidence.files[1].url, new RegExp(`/src/commit/${sha("a")}/.github/ISSUE_TEMPLATE/Bug%20report.yml$`));
  assert.ok(evidence.truncated);
  assert.equal(calls.length, fixtures.size);
  await assert.rejects(executeForgejoOperation(config, covered, "repositories.evidence.read", { path: ".env" }), status(400));
  await assert.rejects(executeForgejoOperation(config, covered, "repositories.evidence.read", { ref: "other" }), status(400));
  await assert.rejects(executeForgejoOperation(config, covered, "raw.get", {}), status(403));
  assert.equal(calls.length, fixtures.size);
});

test("marker lookup enumerates the bot's open and closed issues and distinguishes failure", async (t) => {
  const tagged = "<!-- outfitter-request:request:abcdef12 -->";
  const entry = (number: number, body: string, user = 2) => ({
    number, body, user: { id: user }, state: "closed", html_url: "https://ignored.example/",
  });
  let pages = [[entry(1, "<!-- outfitter-request:request:abcdef123 -->")], [entry(2, tagged)]];
  let total: string | undefined = "2";
  let providerStatus = 200;
  const calls = mockReads(t, (url) => {
    if (url.pathname === "/api/v1/user") return Response.json({ id: 2, login: "bot" });
    assert.equal(url.pathname, `${repoPath}/issues`);
    assert.equal(url.searchParams.get("created_by"), "bot");
    assert.equal(url.searchParams.get("state"), "all");
    assert.equal(url.searchParams.get("type"), "issues");
    assert.equal(url.searchParams.get("q"), null);
    const index = Number(url.searchParams.get("page")) - 1;
    return Response.json(pages[index] ?? [], { status: providerStatus, headers: total ? { "x-total-count": total } : {} });
  });
  
  const lookup = () => executeForgejoOperation(config, covered, "issues.find-by-marker", { marker: "request:ABCDEF12" });
  assert.deepEqual(await lookup(), { number: 2, url: `${config.origin}/box/repo/issues/2`, state: "closed", created: false });
  assert.equal(calls.length, 3);
  pages = [[entry(1, `${tagged}more`.replace(" -->", "-else -->"))], []];
  total = "1";
  assert.equal(await lookup(), null);
  pages = [[entry(1, tagged, 3)]];
  await assert.rejects(lookup(), status(502));
  pages = [[entry(1, tagged), entry(2, tagged)]];
  total = "2";
  await assert.rejects(lookup(), status(409));
  pages = [[]];
  total = undefined;
  await assert.rejects(lookup(), status(502));
  total = "301";
  await assert.rejects(lookup(), status(502));
  total = "1";
  await assert.rejects(lookup(), status(502));
  providerStatus = 503;
  await assert.rejects(lookup(), status(502));
  await assert.rejects(executeForgejoOperation(config, covered, "issues.find-by-marker", { marker: "too-short!" }), status(400));
});

test("read-only preflight checks issue availability and needs an independent create declaration", async (t) => {
  const preflight = "issues.preflight-create";
  let metadata = { id: 7, full_name: "box/repo", has_issues: true, archived: false };
  let providerStatus = 200;
  let botUserId = 2;
  let version = "11.0.16+gitea-1.22.0";
  const writable = { id: 1, token_last_eight: token.slice(-8), scopes: ["write:issue"], repositories: null };
  const other = { id: 2, token_last_eight: "bbbbbbbb", scopes: ["write:issue"], repositories: null };
  let records: unknown[] = [writable, other];
  let total: number | undefined;
  const calls = mockReads(t, (url) => {
    if (url.pathname === repoPath) return Response.json(metadata);
    if (url.pathname === "/api/v1/user") return Response.json({ id: botUserId, login: "bot" });
    if (url.pathname === "/api/v1/version") return Response.json({ version });
    if (url.pathname === "/api/v1/users/bot/tokens") {
      assert.equal(url.search, "?limit=50&page=1");
      return Response.json(records, { headers: { "x-total-count": String(total ?? records.length) } });
    }
    assert.equal(url.pathname + url.search, `${repoPath}/issues?state=all&type=issues&limit=1`);
    return Response.json([], { status: providerStatus });
  });
  
  const check = () => executeForgejoOperation(config, covered, preflight, {});
  assert.deepEqual(await check(), { allowed: true, botUserId: 2 });
  assert.equal(calls.length, 4);
  botUserId = 3;
  await assert.rejects(check(), status(403));
  botUserId = 2;

  for (const refused of [
    [other],
    [{ ...writable, scopes: ["read:issue"] }, other],
    [writable, { ...other, token_last_eight: writable.token_last_eight }],
    [{ ...writable, repositories: [{ id: 8 }] }],
  ]) {
    records = refused;
    await assert.rejects(check(), status(403));
  }
  records = [{ ...writable, repositories: [{ id: 7 }] }];
  assert.deepEqual(await check(), { allowed: true, botUserId: 2 });
  total = 2;
  await assert.rejects(check(), status(502));
  total = undefined;
  records = [{ ...writable, repositories: undefined }];
  assert.deepEqual(await check(), { allowed: true, botUserId: 2 });
  version = "17.0.0";
  await assert.rejects(check(), status(403));

  records = [writable];
  providerStatus = 404;
  await assert.rejects(check(), status(404));
  for (const ineligible of [{ has_issues: false }, { archived: true }, { id: 8 }]) {
    metadata = { ...metadata, ...ineligible };
    await assert.rejects(check(), status(403));
  }
  await assert.rejects(executeForgejoOperation(config, covered, preflight, { route: "/issues" }), status(400));
});
