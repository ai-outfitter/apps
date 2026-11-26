import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash, verify } from "node:crypto";
import { credentials, issue, repoPath } from "./fixture.mjs";

export const appId = 100001;
export const reviewerId = 100002;
export const githubInstallationId = 100003;
export const appSlug = "fixture-foundry";
const reviewerToken = "ghp_fixture_reviewer";
const userToken = "ghu_fixture_member";
const oauthCode = "fixture-code";
const oauthClient = "github-fixture-client";
const oauthSecret = "github-fixture-secret";
const owner = { id: 100005, login: "box", type: "Organization" };
const installation = { id: githubInstallationId, app_id: appId, app_slug: appSlug, suspended_at: null,
  account: owner, permissions: { metadata: "read", contents: "write", issues: "read", pull_requests: "write" } };
const bot = { id: 100004, login: `${appSlug}[bot]`, type: "Bot" };
const reviewer = { id: reviewerId, login: "reviewer", type: "User" };
const member = { id: 100006, login: "fixture-member", type: "User" };
const minted = new Map();
const signedCommits = new Set();
const origin = `https://github.com/${issue.repository}`;
const native = "http://127.0.0.1:3300/api/v1";
const tokens = () => credentials({ env: process.env });
const reply = (res, status, value) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
function appJwt(token) {
  if (!token) return false;
  const [header, payload, signature, extra] = token.split(".");
  if (!signature || extra !== undefined) return false;
  try {
    const { alg } = JSON.parse(Buffer.from(header, "base64url"));
    const { iss, iat, exp } = JSON.parse(Buffer.from(payload, "base64url"));
    const now = Date.now() / 1000;
    return alg === "RS256" && String(iss) === String(appId) && iat <= now && exp > now &&
      exp - iat <= 660 && verify("RSA-SHA256", Buffer.from(`${header}.${payload}`),
        readFileSync("/out/github-public-key.pem"), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
const journal = entry => appendFileSync("/out/github-requests.jsonl", JSON.stringify(entry) + "\n");

async function parseBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
}

function pullShape(pull) {
  return { ...pull, user: bot, html_url: `${origin}/pull/${pull.number}`, draft: true };
}

function reviewShape(review, number) {
  return { ...review, user: reviewer, html_url: `${origin}/pull/${number}#pullrequestreview-${review.id}`,
    state: review.state === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : review.state };
}

export async function githubFixture(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname: path } = url;
  const method = req.method;
  const token = req.headers.authorization?.replace(/^Bearer /i, "");
  const permissions = minted.get(token);
  const actor = token === userToken ? "member" : token === reviewerToken ? "reviewer" :
    permissions ? "installation" : appJwt(token) ? "app-jwt" : "unknown";
  const output = (status, value, details) => {
    journal({ method, path, actor, status, ...details });
    return reply(res, status, value);
  };
  const fetchNative = async (suffix, verb = "GET", body, kind = "admin") => {
    const response = await fetch(native + repoPath + suffix, {
      method: verb, headers: { authorization: tokens()[kind], "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    return [response.status, result];
  };
  try {
    if (path === "/login/oauth/access_token" && method === "POST") {
      const body = new URLSearchParams(Buffer.concat(await Array.fromAsync(req)).toString());
      assert.equal(body.get("client_id"), oauthClient);
      assert.equal(body.get("client_secret"), oauthSecret);
      assert.equal(body.get("code"), oauthCode);
      const { redirect, challenge } = JSON.parse(readFileSync("/box/github-fixture-oauth.json", "utf8"));
      assert.equal(body.get("redirect_uri"), redirect);
      const verifier = body.get("code_verifier");
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
      return output(200, { access_token: userToken, scope: "repo,read:org", token_type: "bearer" });
    }
    if (path === "/user" && method === "GET" && ["member", "reviewer"].includes(actor))
      return output(200, actor === "reviewer" ? reviewer : member);
    if (path === "/app/installations" && method === "GET" && actor === "app-jwt")
      return output(200, [installation]);
    if (path === `${repoPath}/installation` && method === "GET" && actor === "app-jwt")
      return output(200, installation);
    if (path === `/app/installations/${installation.id}/access_tokens` && method === "POST" && actor === "app-jwt") {
      const body = await parseBody(req) ?? {};
      const grants = body.permissions ?? installation.permissions;
      assert.ok(Object.entries(grants).every(([key, grant]) =>
        installation.permissions[key] === grant || (installation.permissions[key] === "write" && grant === "read")));
      const [status, repository] = await fetchNative("");
      assert.equal(status, 200);
      if (body.repository_ids) assert.deepEqual(body.repository_ids, [repository.id]);
      if (body.repositories) assert.deepEqual(body.repositories, [issue.repository.split("/").at(-1)]);
      const next = `ghs_fixture_${minted.size}`;
      minted.set(next, grants);
      appendFileSync("/box/github-fixture-tokens.jsonl", JSON.stringify({ token: next, grants }) + "\n", { mode: 0o600 });
      return output(201, { token: next, expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: grants, repositories: [{ id: repository.id, full_name: issue.repository }] }, { permissions: grants });
    }
    if (method === "GET" && ["/user/repos", "/installation/repositories", repoPath].includes(path) &&
        ["member", "reviewer", "installation"].includes(actor)) {
      const [status, value] = await fetchNative("");
      if (status !== 200) return output(status, value);
      const repo = { ...value, owner, full_name: issue.repository, html_url: origin,
        clone_url: `${origin}.git`, archived: false, disabled: false,
        permissions: actor === "installation" ? undefined : { pull: true, push: actor === "member", admin: false } };
      if (path === "/user/repos" && actor === "member") return output(200, [repo]);
      if (path === "/installation/repositories" && actor === "installation") return output(200, { total_count: 1, repositories: [repo] });
      if (path === repoPath) return output(200, repo);
    }
    if (path === "/graphql" && method === "POST" && permissions?.contents === "write") {
      const { query, variables } = await parseBody(req);
      assert.match(query, /createCommitOnBranch/);
      const input = variables.input ?? variables;
      const { branch, expectedHeadOid, message, fileChanges } = input;
      assert.equal(branch.repositoryNameWithOwner, issue.repository);
      const name = branch.branchName;
      const [status, ref] = await fetchNative(`/branches/${name}`);
      assert.equal(status, 200);
      assert.equal(ref.commit.id, expectedHeadOid);
      const files = await Promise.all(fileChanges.additions.map(async ({ path, contents }) => {
        const [status, previous] = await fetchNative(`/contents/${path}?ref=${expectedHeadOid}`);
        assert.ok([200, 404].includes(status));
        return { path, content: contents, operation: status === 200 ? "update" : "create",
          ...(status === 200 ? { sha: previous.sha } : {}) };
      }));
      const [writeStatus, created] = await fetchNative("/contents", "POST",
        { branch: name, message: message.headline, files }, "worker");
      assert.equal(writeStatus, 201, JSON.stringify(created));
      signedCommits.add(created.commit.sha);
      return output(200, { data: { createCommitOnBranch: { commit: { oid: created.commit.sha,
        url: `${origin}/commit/${created.commit.sha}` } } } }, { effect: "commit" });
    }
    if (path.startsWith(repoPath + "/") && ["installation", "reviewer", "member"].includes(actor)) {
      const suffix = path.slice(repoPath.length);
      if (method === "GET" && suffix.startsWith("/git/ref/heads/")) {
        const name = suffix.slice("/git/ref/heads/".length);
        const [status, value] = await fetchNative(`/branches/${name}`);
        return output(status, status === 200 ? { ref: `refs/heads/${name}`, object: { type: "commit", sha: value.commit.id } } : value);
      }
      if (method === "GET" && suffix === `/issues/${issue.number}`) {
        const [status, value] = await fetchNative(suffix);
        return output(status, { ...value, html_url: `${origin}/issues/${issue.number}` });
      }
      if (method === "GET" && suffix.startsWith("/commits/")) {
        const [status, value] = await fetchNative(suffix.replace("/commits/", "/git/commits/"));
        if (status === 200 && signedCommits.has(value.sha)) {
          value.author = bot;
          value.commit.verification = { verified: true };
        }
        return output(status, value);
      }
      if (method === "GET" && /^\/(git\/(trees|blobs)\/|contents\/)/.test(suffix))
        return output(...await fetchNative(suffix + url.search));
      if (method === "GET" && /^\/pulls(?:\/\d+)?$/.test(suffix)) {
        if (suffix === "/pulls" && actor === "installation") {
          const head = url.searchParams.get("head");
          assert.match(head, /^box:outfitter-review-[0-9a-f-]+$/);
          assert.equal(url.searchParams.get("state"), "all");
          assert.equal(url.searchParams.get("per_page"), "50");
          const [sourceOwner, sourceRef] = head.split(":");
          const page = Number(url.searchParams.get("page"));
          assert.ok(Number.isSafeInteger(page) && page > 0);
          const [status, value] = await fetchNative("/pulls?state=all");
          return output(status, status === 200 ? value.filter(pull =>
            pull.head.repo.full_name.split("/")[0] === sourceOwner && pull.head.ref === sourceRef)
            .slice((page - 1) * 50, page * 50).map(pullShape) : value, { head });
        }
        const [status, value] = await fetchNative(suffix + url.search);
        return output(status, status !== 200 ? value : Array.isArray(value) ? value.map(pullShape) : pullShape(value));
      }
      if (method === "GET" && /^\/pulls\/\d+\/reviews$/.test(suffix)) {
        const [status, value] = await fetchNative(suffix);
        return output(status, status === 200 ? value.map(review => reviewShape(review, suffix.split("/")[2])) : value);
      }
      if (method === "POST" && suffix === "/git/refs" && permissions?.contents === "write") {
        const { ref, sha } = await parseBody(req);
        assert.match(ref, /^refs\/heads\/outfitter-review-[0-9a-f-]+$/);
        const [status, value] = await fetchNative("/branches", "POST",
          { new_branch_name: ref.slice("refs/heads/".length), old_ref_name: sha }, "worker");
        return output(status, status === 201 ? { ref, object: { sha, type: "commit" } } : value, { effect: "branch" });
      }
      if (method === "POST" && suffix === "/pulls" && permissions?.pull_requests === "write") {
        const { draft, ...body } = await parseBody(req);
        assert.equal(draft, true);
        const [status, value] = await fetchNative(suffix, "POST", { ...body, title: `WIP: ${body.title}` }, "worker");
        return output(status, status === 201 ? pullShape(value) : value, { effect: "draft" });
      }
      if (method === "POST" && /^\/pulls\/\d+\/reviews$/.test(suffix) && actor === "reviewer") {
        const body = await parseBody(req);
        assert.ok(["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(body.event));
        const [status, value] = await fetchNative(suffix, "POST",
          { ...body, event: { APPROVE: "APPROVED", REQUEST_CHANGES: "REQUEST_CHANGES", COMMENT: "COMMENT" }[body.event] }, "reviewer");
        return output(status, status >= 400 ? value : reviewShape(value, suffix.split("/")[2]), { effect: "review", head: body.commit_id });
      }
    }
    return output(404, { message: "Fixture route unavailable" }, { unexpected: true });
  } catch (error) {
    return output(422, { message: error.message }, { unexpected: true, diagnostic: error.message });
  }
}
