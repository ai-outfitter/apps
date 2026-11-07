#!/usr/bin/env node
// The box's entrypoint. It starts every service on loopback, prepares Forgejo
// and RustFS, imports the mounted repository, starts the platform with the
// box's app installed, and hands the requests to that app's driver
// (`apps/<app>/box/driver.mjs`, BOX_APP naming the app). Only the
// platform, which serves the app for inspection, listens on the published port.
//
//   /in/repo       the repository to work on (mounted read-only)
//   /in/requests   request JSON files, in the app's own schema
//   /out           results, the final git bundle, artifacts and evidence
//   /box           service state inside the container
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const env = process.env;
const HERE = dirname(fileURLToPath(import.meta.url));
/** The webapp checkout the image runs the platform from. */
const CHECKOUT = env.BOX_CHECKOUT || "/app";
const STATE = env.BOX_STATE || "/box";
const OUT = env.BOX_OUT || "/out";
const PORTS = { forgejo: 3300, rustfs: 9000, kube: 7070, gateway: 4040, webapp: Number(env.BOX_INSPECT_PORT || 8787) };
const FORGEJO = `http://127.0.0.1:${PORTS.forgejo}`;
const PLATFORM = `http://127.0.0.1:${PORTS.webapp}`;
const OWNER = "box";
const BOT = "outfitter";
/** The box organization's seed id (the webapp's scripts/local-dev/box-platform.ts). */
const BOX_ORGANIZATION = "b0c50000-0000-4000-8000-000000000001";
const children = [];

const driver = await import(env.BOX_DRIVER || join(HERE, "..", "apps", env.BOX_APP || "software-foundry", "box", "driver.mjs"));
const APP = driver.app;
if (typeof APP !== "string" || typeof driver.run !== "function") throw new Error("The box driver must export app and run()");

function log(message) {
  console.error(`${APP}-box: ${message}`);
}

/** Secrets generated once per box and kept in its state folder. */
function secret(name) {
  const file = join(STATE, "secrets", name);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(join(STATE, "secrets"), { recursive: true, mode: 0o700 });
  const value = randomBytes(24).toString("hex");
  writeFileSync(file, value, { mode: 0o600 });
  return value;
}

/** Model provider settings (see README, "Models"). Only the gateway, which
 * proxies every workspace's inference, receives them. */
const MODEL_SETTINGS = /^(OPENAI_|SPARK_|INFERENCE_PROVIDERS$|AI_MODEL$)/;
const withoutModelSettings = (values) => Object.fromEntries(Object.entries(values).filter(([name]) => !MODEL_SETTINGS.test(name)));

function start(name, command, args, extra = {}, { modelSettings = false } = {}) {
  const base = modelSettings ? env : withoutModelSettings(env);
  const child = spawn(command, args, { env: { ...base, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log(`${name} exited (${signal ?? code}); stopping the box`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { env: { ...env, ...extra }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function ready(name, url, attempts = 60) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${name} did not start`);
}

/** Forgejo's app.ini: SQLite, loopback only, no registration, no outside calls. */
function forgejoConfig() {
  const dir = join(STATE, "forgejo");
  mkdirSync(join(dir, "custom", "conf"), { recursive: true });
  const ini = `APP_NAME = Outfitter box
RUN_MODE = prod
WORK_PATH = ${dir}
[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${PORTS.forgejo}
ROOT_URL = ${FORGEJO}/
DISABLE_SSH = true
OFFLINE_MODE = true
[database]
DB_TYPE = sqlite3
PATH = ${dir}/forgejo.db
[security]
INSTALL_LOCK = true
SECRET_KEY = ${secret("forgejo-secret")}
INTERNAL_TOKEN = ${secret("forgejo-internal")}
[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
[repository]
DEFAULT_BRANCH = main
[webhook]
ALLOWED_HOST_LIST = loopback
[mailer]
ENABLED = false
[log]
LEVEL = Warn
`;
  writeFileSync(join(dir, "custom", "conf", "app.ini"), ini);
  return { dir, config: join(dir, "custom", "conf", "app.ini") };
}

/** Creates the admin and bot users once and returns the bot's token and id. */
async function forgejoUsers({ config }) {
  const forgejo = (args) => run("forgejo", ["--config", config, ...args]);
  const tokenFile = join(STATE, "secrets", "forgejo-bot-token");
  for (const [user, admin] of [["box-admin", true], [BOT, false], ["reviewer", false]]) {
    try {
      forgejo(["admin", "user", "create", "--username", user, "--email", `${user}@box.local`,
        "--password", secret(`forgejo-${user}-password`), "--must-change-password=false", ...(admin ? ["--admin"] : [])]);
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
    }
  }
  const accessToken = (user, name) => {
    const file = join(STATE, "secrets", `forgejo-${user}-token`);
    if (!existsSync(file)) {
      const output = forgejo(["admin", "user", "generate-access-token", "--username", user, "--token-name", name,
        "--scopes", "write:repository,write:issue,read:user", "--raw"]);
      writeFileSync(file, output.split("\n").pop().trim(), { mode: 0o600 });
    }
    return readFileSync(file, "utf8").trim();
  };
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : accessToken(BOT, "platform");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600 });
  const me = await (await fetch(`${FORGEJO}/api/v1/user`, { headers: { Authorization: `token ${token}` } })).json();
  // The independent reviewer publishes formal reviews through the gateway.
  return { token, botUserId: me.id, reviewerToken: accessToken("reviewer", "reviews") };
}

/** Creates the box organization and repository, and pushes the mounted repo into it. */
async function importRepository(adminAuth, name) {
  const api = (method, path, body) =>
    fetch(`${FORGEJO}/api/v1${path}`, {
      method,
      headers: { Authorization: adminAuth, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  await api("POST", "/orgs", { username: OWNER, visibility: "private" });
  const created = await api("POST", `/orgs/${OWNER}/repos`, { name, private: true, auto_init: false });
  if (created.status !== 201 && created.status !== 409) throw new Error(`Creating ${OWNER}/${name} failed (${created.status})`);
  await api("PUT", `/repos/${OWNER}/${name}/collaborators/${BOT}`, { permission: "write" });
  await api("PUT", `/repos/${OWNER}/${name}/collaborators/reviewer`, { permission: "write" });
  const source = env.BOX_REPO || "/in/repo";
  const branch = run("git", ["-c", "safe.directory=*", "-C", source, "symbolic-ref", "--short", "HEAD"]);
  const remote = `${FORGEJO.replace("http://", `http://box-admin:${secret("forgejo-box-admin-password")}@`)}/${OWNER}/${name}.git`;
  // Push every branch and tag as they are; the mounted repository is never changed.
  // The mount is owned by the host user, so trust it explicitly for git.
  const git = ["-c", "safe.directory=*", "-C", source];
  run("git", [...git, "push", "--quiet", remote, "--all"]);
  run("git", [...git, "push", "--quiet", remote, "--tags"]);
  await api("PATCH", `/repos/${OWNER}/${name}`, { default_branch: branch });
  return { repository: `${OWNER}/${name}`, defaultBranch: branch };
}

let stopping = false;
function shutdown(code = 0) {
  stopping = true;
  for (const child of children.reverse()) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

/** What every driver gets: the box's services, as the platform bot. */
function driverContext({ gatewayToken, bot, repo, s3 }) {
  const remote = `${FORGEJO.replace("http://", `http://${BOT}:${bot.token}@`)}/${repo.repository}.git`;
  const forgejo = async (method, path, body) => {
    const response = await fetch(`${FORGEJO}/api/v1${path}`, {
      method, headers: { Authorization: `token ${bot.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Forgejo ${method} ${path} failed (${response.status})`);
    return response.json();
  };
  /** An operator request to the box app's workflows, as the box organization. */
  const operator = async (input) => {
    const response = await fetch(`${PLATFORM}/api/internal/app-workflows/${APP}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ organization: OWNER, connectionId: "box-forgejo", input }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${APP} ${input.operation} failed (${response.status}): ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  const s3client = new AwsClient({ accessKeyId: s3.ATTACHMENTS_S3_ACCESS_KEY_ID, secretAccessKey: s3.ATTACHMENTS_S3_SECRET_ACCESS_KEY,
    service: "s3", region: "auto", retries: 0 });
  /** Writes to the box bucket in RustFS and returns the object's s3:// URI. */
  const store = async (key, bytes, type) => {
    const response = await s3client.fetch(`${s3.ATTACHMENTS_S3_ENDPOINT}/${s3.ATTACHMENTS_S3_BUCKET}/${key}`,
      { method: "PUT", body: bytes, headers: { "Content-Type": type } });
    if (!response.ok) throw new Error(`Storing ${key} failed (${response.status})`);
    return `s3://${s3.ATTACHMENTS_S3_BUCKET}/${key}`;
  };
  // The local-organizations loader keys its runtime folder by checkout (webapp scripts/local-dev/runtime.ts).
  const runtime = createHash("sha256").update(CHECKOUT).digest("hex").slice(0, 16);
  /** Writes the final history of every branch and tag to /out/repo.bundle and,
   * for an eval run (BOX_EXIT_WHEN_DONE), stops the box. */
  const finish = async (failure) => {
    try {
      if (failure) throw failure;
      const directory = join(STATE, "final");
      rmSync(directory, { recursive: true, force: true });
      run("git", ["clone", "--quiet", "--mirror", remote, directory]);
      run("git", ["-C", directory, "bundle", "create", join(OUT, "repo.bundle"), "--all"]);
      log("all requests finished");
      if (env.BOX_EXIT_WHEN_DONE) shutdown(0);
    } catch (error) {
      log(`finishing failed: ${error.message}`);
      if (env.BOX_EXIT_WHEN_DONE) shutdown(1);
    }
  };
  return {
    env, log, out: OUT, platform: PLATFORM, port: PORTS.webapp, image: env.BOX_IMAGE || `outfitter/${APP}-box:dev`,
    requests: env.BOX_REQUESTS || "/in/requests",
    repository: repo.repository, defaultBranch: repo.defaultBranch, remote,
    model: { provider: env.SPARK_BASE_URL ? "spark" : "luna", id: env.AI_MODEL || "gpt-6-luna" },
    forgejo, operator, store, finish,
    databases: {
      platform: join(STATE, "platform", "runtime", runtime, "platform.db"),
      gateway: join(STATE, "workspaces.db"),
    },
  };
}

async function main() {
  mkdirSync(STATE, { recursive: true });
  mkdirSync(join(OUT, "results"), { recursive: true });
  // RustFS: release artifacts and evidence.
  const s3 = { ATTACHMENTS_S3_ENDPOINT: `http://127.0.0.1:${PORTS.rustfs}`, ATTACHMENTS_S3_BUCKET: APP === "software-foundry" ? "foundry" : APP,
    ATTACHMENTS_S3_ACCESS_KEY_ID: "box", ATTACHMENTS_S3_SECRET_ACCESS_KEY: secret("rustfs"), ATTACHMENTS_S3_REGION: "auto" };
  mkdirSync(join(STATE, "rustfs"), { recursive: true });
  start("rustfs", "rustfs", [join(STATE, "rustfs")], {
    RUSTFS_ADDRESS: `127.0.0.1:${PORTS.rustfs}`, RUSTFS_ACCESS_KEY: s3.ATTACHMENTS_S3_ACCESS_KEY_ID, RUSTFS_SECRET_KEY: s3.ATTACHMENTS_S3_SECRET_ACCESS_KEY,
  });
  // Forgejo: the git server, issues, PRs, reviews and releases.
  const forgejo = forgejoConfig();
  start("forgejo", "forgejo", ["--config", forgejo.config, "web"], { GITEA_WORK_DIR: forgejo.dir, FORGEJO_WORK_DIR: forgejo.dir });
  await ready("Forgejo", `${FORGEJO}/api/healthz`);
  const bot = await forgejoUsers(forgejo);
  const adminAuth = `Basic ${Buffer.from(`box-admin:${secret("forgejo-box-admin-password")}`).toString("base64")}`;
  const repo = await importRepository(adminAuth, env.BOX_REPO_NAME || "repo");
  run("node", [join(CHECKOUT, "scripts/attachments-bucket.mjs")], s3);
  // Workflow artifacts (node sessions, evidence) in their own bucket on the same RustFS.
  run("node", [join(CHECKOUT, "scripts/attachments-bucket.mjs")], { ...s3, ATTACHMENTS_S3_BUCKET: "artifacts" });
  const artifactsS3 = Object.fromEntries(Object.entries({ ...s3, ATTACHMENTS_S3_BUCKET: "artifacts" })
    .map(([name, value]) => [name.replace("ATTACHMENTS_", "ARTIFACTS_"), value]));
  const forge = { REPOSITORY_FORGE: "forgejo", FORGEJO_URL: FORGEJO, FORGEJO_TOKEN: bot.token, FORGEJO_BOT_USER_ID: String(bot.botUserId) };
  // box-kube: workspaces as local runtime processes, with git and gh on Forgejo.
  writeFileSync(join(STATE, "kube-token"), "box");
  start("box-kube", "node", [join(HERE, "box-kube.mjs")], {
    BOX_KUBE_PORT: String(PORTS.kube), BOX_KUBE_STATE: join(STATE, "kube.json"), BOX_WORKSPACES_DIR: join(STATE, "workspaces"),
    BOX_RUNTIME_SCRIPT: "/opt/workspace/server.mjs", BOX_GATEWAY_URL: `http://127.0.0.1:${PORTS.gateway}`,
    OUTFITTER_FORGE: "forgejo", OUTFITTER_FORGE_ORIGIN: FORGEJO, ...(env.AI_MODEL ? { AI_MODEL: env.AI_MODEL } : {}),
  });
  const gatewayToken = secret("gateway");
  start("gateway", "node", [join(CHECKOUT, "workspace/gateway.mjs")], {
    WORKSPACE_GATEWAY_PORT: String(PORTS.gateway), WORKSPACE_DATABASE_URL: `file:${join(STATE, "workspaces.db")}`, KUBERNETES_API_URL: `http://127.0.0.1:${PORTS.kube}`, KUBERNETES_TOKEN_FILE: join(STATE, "kube-token"),
    WORKSPACE_RUNTIME_ORIGIN: `http://127.0.0.1:${PORTS.kube}/runtime/{namespace}/{id}`, WORKSPACE_GATEWAY_TOKEN: gatewayToken, ...forge, ...(env.BOX_DEBUG_HOST ? { WORKSPACE_DEBUG_ERRORS: "1" } : {}),
    // The platform names the box organization's app installation deterministically (scripts/local-dev).
    WORKSPACE_REVIEWERS: JSON.stringify([{ id: "reviewer", login: "reviewer", token: bot.reviewerToken,
      organizationId: `local-${BOX_ORGANIZATION}`, installationId: `local-${BOX_ORGANIZATION}-${APP}` }]),
  }, { modelSettings: true });
  // The platform, serving the box app for inspection: the box organization
  // with the app installed and a Forgejo-backed repository connection.
  const owner = await (await fetch(`${FORGEJO}/api/v1/orgs/${OWNER}`, { headers: { Authorization: adminAuth } })).json();
  // A driver whose app calls a model from the platform itself (Workshop's
  // design agent) has the platform receive the model settings too.
  const platformModel = driver.platformModel ? Object.fromEntries(Object.entries(env).filter(([name]) => MODEL_SETTINGS.test(name))) : {};
  start("platform", "node", ["--import", "tsx", join(CHECKOUT, "scripts/local-dev/box-platform.ts")], {
    BOX_CHECKOUT: CHECKOUT, BOX_STATE: STATE, BOX_INSPECT_PORT: String(PORTS.webapp), BOX_REPOSITORY: repo.repository,
    BOX_FORGEJO_OWNER_ID: String(owner.id), BOX_APPS: APP, BOX_TITLE: driver.title ?? `${APP} box`,
    BOX_PLATFORM_ENV: JSON.stringify({
      WORKSPACE_GATEWAY_URL: `http://127.0.0.1:${PORTS.gateway}`, WORKSPACE_GATEWAY_TOKEN: gatewayToken, ...forge, ...s3, ...artifactsS3,
      ...platformModel, ...(env.BOX_DEBUG_HOST ? { BOX_DEBUG_HOST: "1" } : {}),
    }),
  });
  await ready("platform", `${PLATFORM}/api/health`, 600);
  await driver.run(driverContext({ gatewayToken, bot, repo, s3 }));
  // The workflow tick a self-hosted server gets from its gateway every 15
  // minutes, here every few seconds so runs advance as soon as they can.
  const tick = async () => {
    try {
      const response = await fetch(`${PLATFORM}/api/internal/workflow-schedules/tick`, {
        method: "POST", headers: { Authorization: `Bearer ${gatewayToken}`, "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) log(`workflow tick failed (${response.status})`);
      await response.body?.cancel();
    } catch (error) {
      log(`workflow tick failed: ${error.message}`);
    }
    setTimeout(tick, Number(env.BOX_TICK_MS || 5000)).unref?.();
  };
  void tick();
  writeFileSync(join(OUT, "box.json"), `${JSON.stringify({ app: APP, forgejo: FORGEJO, ...repo, inspect: PORTS.webapp }, null, 2)}\n`);
  log(`ready: ${repo.repository} on ${repo.defaultBranch}; inspect on :${PORTS.webapp}`);
}

main().catch((error) => {
  log(error.message);
  // BOX_HOLD keeps the services up after a setup failure, for inspection.
  if (env.BOX_HOLD) log("holding the box open (BOX_HOLD)");
  else shutdown(1);
});
