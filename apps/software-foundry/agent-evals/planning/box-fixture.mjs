import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const anchor = "box/native-apple";
export const charts = "box/charts";
export const repositories = [charts, anchor];
const forgejo = "http://127.0.0.1:3300";

function adminPassword(box) {
  return readFileSync(join(box.env.BOX_STATE ?? "/box", "secrets", "forgejo-box-admin-password"), "utf8").trim();
}

export async function admin(box, method, path, body) {
  const password = adminPassword(box);
  const response = await fetch(`${forgejo}/api/v1${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`box-admin:${password}`).toString("base64")}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `Forgejo admin ${method} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

export const setBotPermission = (box, repository, permission) =>
  admin(box, "PUT", `/repos/${repository}/collaborators/outfitter`, { permission });

export async function addChartsRepository(box, db) {
  await admin(box, "POST", "/orgs/box/repos", { name: "charts", private: true, auto_init: true, default_branch: "main" });
  await setBotPermission(box, charts, "write");
  const credentials = Buffer.from(`box-admin:${adminPassword(box)}`).toString("base64");
  execFileSync("git", ["-c", "safe.directory=/in/charts", "-C", "/in/charts", "push", "--quiet", "--force",
    `${forgejo}/${charts}.git`, "refs/heads/main:refs/heads/main"], {
    env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (const repository of repositories) {
    const metadata = await admin(box, "PATCH", `/repos/${repository}`, { has_issues: true, has_pull_requests: true, default_branch: "main" });
    assert.equal(metadata.has_pull_requests, true);
  }
  setCoverage(db, repositories);
}

export function openPlatform(box) {
  const db = new DatabaseSync(box.databases.platform);
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

export function setCoverage(db, scoped) {
  const { config } = db.prepare("SELECT config FROM connections WHERE id = 'box-forgejo'").get();
  const next = JSON.stringify({ ...JSON.parse(config), repositories: scoped });
  assert.equal(db.prepare("UPDATE connections SET config = ? WHERE id = 'box-forgejo'").run(next).changes, 1);
}

export async function registerForgejoHook(box) {
  const secret = randomBytes(32).toString("hex");
  writeFileSync("/box/planning-webhook-secret", secret, { mode: 0o600 });
  await admin(box, "POST", `/repos/${anchor}/hooks`, {
    type: "forgejo",
    config: { url: `http://127.0.0.1:${box.port}/api/webhooks/foundry-planning-eval`, content_type: "json", secret },
    events: ["issues"], active: true,
  });
}

export function removeAppIssueGrant(db) {
  const statement = db.prepare("UPDATE app_installations SET capabilities = ? WHERE id = ?");
  const { id, capabilities } = db.prepare(
    "SELECT id, capabilities FROM app_installations WHERE template = 'software-foundry' AND organizationId IS NOT NULL",
  ).get();
  const current = JSON.parse(capabilities);
  assert.ok(current.includes("connector.forgejo.issues.create"));
  const restricted = current.filter((item) => item !== "connector.forgejo.issues.create");
  assert.equal(statement.run(JSON.stringify(restricted), id).changes, 1);
  return () => assert.equal(statement.run(capabilities, id).changes, 1);
}

export async function useReadOnlyBotToken(db) {
  const scoped = execFileSync("forgejo", ["--config", "/box/forgejo/custom/conf/app.ini", "admin", "user",
    "generate-access-token", "--username", "outfitter", "--token-name", "planning-read-only", "--scopes",
    "read:repository,read:issue,read:user", "--raw"], { encoding: "utf8" }).trim().split("\n").at(-1);
  assert.ok(/^[a-f0-9]{40}$/.test(scoped), "Forgejo created a scoped PAT");
  const { developmentAuthSecret } = await import("/app/scripts/local-dev/auth-secret.mjs");
  const require = createRequire("/app/package.json");
  const { symmetricEncrypt } = await import(require.resolve("better-auth/crypto"));
  const encrypted = await symmetricEncrypt({ key: developmentAuthSecret(), data: scoped });
  const previous = db.prepare("SELECT encryptedSecret, revision FROM connections WHERE id = 'box-forgejo'").get();
  const statement = db.prepare("UPDATE connections SET encryptedSecret = ?, revision = ? WHERE id = 'box-forgejo'");
  assert.equal(statement.run(encrypted, crypto.randomUUID()).changes, 1);
  return () => assert.equal(statement.run(previous.encryptedSecret, previous.revision).changes, 1);
}
