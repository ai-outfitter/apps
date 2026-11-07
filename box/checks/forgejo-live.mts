// Live check: the Foundry's Forgejo adapter (apps#28) and the workspace gh shim
// against the box's real Forgejo. See ../README.md, "Live Forgejo check".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Both modules exist only inside the check's container (see the README).
const adapterPath = "/apps/apps/software-foundry/src/server/workspace/forgejo.ts";
const shimPath = "/opt/workspace/forgejo-cli.mjs";
const { ForgejoFoundryForge } = await import(adapterPath);
const { forgejoGh, forgejoApi } = await import(shimPath);

const origin = "http://127.0.0.1:3300";
const repo = "box/repo";
const env = process.env;
const botToken = env.BOT_TOKEN ?? "";
const reviewerPassword = env.REVIEWER_PASSWORD ?? "";
const call = (auth: string) => async (path: string, body?: unknown, method?: string) => {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const r = await fetch(`${origin}/api/v1${path}`, { method: verb, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${verb} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const bot = call(`token ${botToken}`);
const reviewerApi = call(`Basic ${Buffer.from(`reviewer:${reviewerPassword}`).toString("base64")}`);
const step = (name: string) => console.log(`✓ ${name}`);

const me = await bot("/user");
const reviewer = await reviewerApi("/user");
const forge = new ForgejoFoundryForge(bot, repo, me.id);

const created = await bot(`/repos/${repo}/issues`, { title: "Add a subtract helper", body: "Feature request from the box live check." });
const issue = await forge.issue(created.number);
assert.equal(issue.title, "Add a subtract helper");
step(`issue #${issue.number} read through the adapter`);

const dir = mkdtempSync("/tmp/live-");
const remote = `http://outfitter:${botToken}@127.0.0.1:3300/${repo}.git`;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=outfitter", "-c", "user.email=outfitter@box.local", ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["clone", "-q", remote, dir]);
const branch = `outfitter/issue-${issue.number}-live`;
git("checkout", "-q", "-b", branch);
writeFileSync(join(dir, `subtract-${issue.number}.mjs`), "export const subtract = (a, b) => a - b;\n");
git("add", ".");
git("commit", "-qm", "feat: subtract helper");
git("push", "-q", "origin", branch);
const headSha = git("rev-parse", "HEAD");
step(`branch ${branch} pushed at ${headSha.slice(0, 8)}`);

const out: string[] = [];
const last = () => out[out.length - 1] ?? "";
const gh = (args: string[]) => forgejoGh(args, { api: forgejoApi(origin, botToken), repository: repo, print: (t: string) => out.push(t) });
await gh(["pr", "create", "--head", branch, "--title", "feat: subtract helper", "--body", `Adds subtract.\n\nCloses #${issue.number}`, "--draft"]);
await gh(["pr", "view", "--head", branch, "--json", "number,isDraft,headRefOid,closingIssuesReferences,state"]);
const view = JSON.parse(last());
assert.equal(view.isDraft, true);
assert.equal(view.headRefOid, headSha);
assert.deepEqual(view.closingIssuesReferences, [{ number: issue.number }]);
step(`gh pr create --draft opened #${view.number} as WIP; gh pr view reads it back`);

const candidate = { number: view.number, headSha, branch, url: out[0] };
const change = await forge.change(candidate, issue.number, branch);
assert.equal(change.headSha, headSha);
step("adapter accepts the PR as the change for the issue");

await forge.ready(change);
await gh(["pr", "view", String(view.number), "--json", "isDraft"]);
assert.equal(JSON.parse(last()).isDraft, false);
step("adapter marks the PR ready (WIP: removed)");

const c1 = await forge.comment(issue.number, "attempt-1", "Triage: small change.");
const c2 = await forge.comment(issue.number, "attempt-1", "Triage: small change.");
assert.equal(c1.id, c2.id);
step("triage comment posted once (idempotent)");

const results = [{ name: "test", headSha, passed: true }];
const k1 = await forge.checks(change, results, "attempt-1");
const k2 = await forge.checks(change, results, "attempt-1");
assert.equal(k1[0].passed, true); assert.deepEqual(k1, k2);
step("check published as a commit status (idempotent)");

await assert.rejects(forge.merge(change, { id: 0, url: "", headSha, verdict: "approved", reviewer }, ["test"], true));
step("merge refused without an independent approval");

const posted = await reviewerApi(`/repos/${repo}/pulls/${view.number}/reviews`, { event: "APPROVED", body: "Looks good.", commit_id: headSha });
const review = { id: posted.id, url: posted.html_url, headSha, verdict: "approved" as const, reviewer: { id: reviewer.id, login: reviewer.login } };
await forge.approval(change, review);
step(`reviewer approval #${posted.id} accepted`);

const merged = await forge.merge(change, review, ["test"], true);
if (!merged) throw new Error("Merge returned no receipt");
assert.match(merged.mergeSha, /^[a-f0-9]{40}$/);
const main = await bot(`/repos/${repo}/branches/main`);
assert.equal(main.commit.id, merged.mergeSha);
const closed = await forge.issue(issue.number);
step(`squash-merged to main at ${merged.mergeSha.slice(0, 8)}; issue is ${closed.state}`);
