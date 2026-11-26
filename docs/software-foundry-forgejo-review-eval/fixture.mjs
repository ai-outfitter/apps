import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const issue = JSON.parse(readFileSync(new URL("./fixtures/issue.json", import.meta.url)));
export const repoPath = `/repos/${issue.repository}`;
const origin = "http://127.0.0.1:3300";

export function credentials(box) {
  const secret = name => readFileSync(join(box.env.BOX_STATE ?? "/box", "secrets", name), "utf8").trim();
  return {
    admin: `Basic ${Buffer.from(`box-admin:${secret("forgejo-box-admin-password")}`).toString("base64")}`,
    worker: `token ${secret("forgejo-bot-token")}`,
    reviewer: `token ${secret("forgejo-reviewer-token")}`,
  };
}

export async function api(auth, path, method = "GET", body) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method, headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(response.ok, `Forgejo ${method} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function seedIssue(box, auth) {
  const [repo, author] = await Promise.all([api(auth.admin, repoPath), api(auth.admin, "/user")]);
  assert.equal(repo.full_name, issue.repository);
  assert.deepEqual(await api(auth.admin, `${repoPath}/issues?type=issues&state=all`), []);
  const db = new DatabaseSync(join(box.env.BOX_STATE ?? "/box", "forgejo", "forgejo.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO issue
      (repo_id, "index", poster_id, name, content, is_closed, is_pull, created_unix, updated_unix, num_comments)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`)
      .run(repo.id, issue.number, author.id, issue.title, issue.body, issue.unixTime, issue.unixTime);
    db.prepare("UPDATE repository SET num_issues = 1 WHERE id = ?").run(repo.id);
    db.prepare('INSERT INTO issue_index (group_id, max_index) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET max_index = excluded.max_index')
      .run(repo.id, issue.number);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const record = await api(auth.admin, `${repoPath}/issues/${issue.number}`);
  assert.equal(record.title, issue.title);
  assert.equal(record.body, issue.body);
  assert.equal(record.state, "open");
  return { repositoryId: repo.id, record };
}

export function mintWorkerRotation(box) {
  const config = join(box.env.BOX_STATE ?? "/box", "forgejo", "custom", "conf", "app.ini");
  const output = execFileSync("forgejo", ["--config", config, "admin", "user", "generate-access-token",
    "--username", "outfitter", "--token-name", "eval-rotation", "--scopes",
    "read:user,write:repository,write:issue", "--raw"], { encoding: "utf8" });
  const token = output.trim().split("\n").at(-1);
  assert.ok(/^[a-f0-9]{40}$/.test(token), "Rotated Forgejo credential was minted");
  return token;
}

function withClone(auth, baseRef, action) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-review-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${auth}`,
    GIT_AUTHOR_NAME: "Synthetic fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Synthetic fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
    GIT_AUTHOR_DATE: "2026-01-01T00:01:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:01:00Z",
    GIT_TERMINAL_PROMPT: "0" };
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { env, encoding: "utf8" }).trim();
  try {
    git("clone", "--quiet", "--branch", baseRef, `${origin}/${issue.repository}.git`, ".");
    return action(git, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function pushFixtureCommit(auth, baseRef, targetRef, content) {
  return withClone(auth, baseRef, (git, directory) => {
    writeFileSync(join(directory, "README.md"), content);
    git("add", "README.md");
    git("commit", "--quiet", "-m", "Record synthetic fixture change");
    git("push", "--quiet", "origin", `HEAD:refs/heads/${targetRef}`);
    return git("rev-parse", "HEAD");
  });
}

export function inspectCandidate(auth, base, head, branch) {
  return withClone(auth, branch, git => ({
    head: git("rev-parse", "HEAD"),
    parents: git("show", "-s", "--format=%P", head).split(" "),
    files: git("diff", "--name-only", base, head).split("\n"),
    readme: git("show", `${head}:README.md`),
  }));

}

export async function inventory(auth) {
  const [branches, issues, pulls] = await Promise.all([
    api(auth, `${repoPath}/branches`),
    api(auth, `${repoPath}/issues?type=issues&state=all`),
    api(auth, `${repoPath}/pulls?state=all`),
  ]);
  return { refs: Object.fromEntries(branches.map(branch => [branch.name, branch.commit.id])),
    issues: issues.map(entry => ({ id: entry.id, number: entry.number, state: entry.state,
      title: entry.title, body: entry.body, comments: entry.comments })),
    pulls: await Promise.all(pulls.map(async pull => ({
      number: pull.number, baseRef: pull.base.ref, baseSha: pull.base.sha, baseRepositoryId: pull.base.repo.id,
      headRef: pull.head.ref, head: pull.head.sha, headRepositoryId: pull.head.repo.id,
      state: pull.state, merged: pull.merged, draft: pull.draft === true || /^(?:draft|wip):/i.test(pull.title), author: pull.user.id, authorLogin: pull.user.login,
      reviews: (await api(auth, `${repoPath}/pulls/${pull.number}/reviews`)).map(review => ({
        id: review.id, head: review.commit_id, actor: review.user.id, login: review.user.login, state: review.state,
      })),
    }))) };
}
