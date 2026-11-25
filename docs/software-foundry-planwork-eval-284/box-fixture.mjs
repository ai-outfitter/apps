import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const owner = "box";
const names = ["charts", "native-apple"];
const repositories = names.map(name => `${owner}/${name}`);
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

const setBotPermission = (box, repository, permission) =>
  admin(box, "PUT", `/repos/${repository}/collaborators/outfitter`, { permission });

export async function seedRepositories(box, db) {
  const credentials = Buffer.from(`box-admin:${adminPassword(box)}`).toString("base64");
  for (const name of names) {
    const repository = `${owner}/${name}`;
    if (repository !== box.repository) {
      await admin(box, "POST", `/orgs/${owner}/repos`, { name, private: true, auto_init: true, default_branch: "main" });
      await setBotPermission(box, repository, "write");
      const source = `/in/planning/${name}`;
      execFileSync("git", ["-c", `safe.directory=${source}`, "-C", source, "push", "--quiet", "--force",
        `${forgejo}/${repository}.git`, "refs/heads/main:refs/heads/main"], {
        env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    const metadata = await admin(box, "PATCH", `/repos/${repository}`, { has_issues: true, has_pull_requests: true, default_branch: "main" });
    assert.equal(metadata.full_name, repository);
    assert.equal(metadata.has_pull_requests, true);
  }
  setCoverage(db, repositories);
}

export function openPlatform(box) {
  const db = new DatabaseSync(box.databases.platform);
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

function setCoverage(db, scoped) {
  const { config } = db.prepare("SELECT config FROM connections WHERE id = 'box-forgejo'").get();
  const next = JSON.stringify({ ...JSON.parse(config), repositories: scoped });
  assert.equal(db.prepare("UPDATE connections SET config = ? WHERE id = 'box-forgejo'").run(next).changes, 1);
}
