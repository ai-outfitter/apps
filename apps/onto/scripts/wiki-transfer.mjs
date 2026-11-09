/** Download/upload a wiki as the currently authorized user, through ordinary APIs. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "Usage: node scripts/wiki-transfer.mjs export|preview|import <main-origin> <backup.json> --installation-id <id> [--organization-id <id>] [--plan <plan.json>]; set OUTFITTER_ACCESS_TOKEN_FILE to your existing OAuth token file";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function save(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function parseArguments(args) {
  const [command, origin, file, ...rest] = args;
  if (!["export", "preview", "import"].includes(command) || !origin || !file || rest.length % 2) throw new Error(usage);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--installation-id", "--organization-id", "--plan"].includes(rest[i]) || options[rest[i]] || !rest[i + 1]) throw new Error(usage);
    options[rest[i]] = rest[i + 1];
  }
  if (!options["--installation-id"] || (command !== "export" && !options["--plan"])) throw new Error(usage);
  const privateFiles = [file, options["--plan"]].filter(Boolean);
  if (privateFiles.some(path => !path.endsWith(".local.json"))) throw new Error("Use .local.json filenames for private backups and plans");
  validateOrigin(origin);
  return { command, origin, file, options };
}

export function validateOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || ["127.0.0.1", "[::1]"].includes(url.hostname))))) throw new Error("Use an exact HTTPS main origin, or a local HTTP origin");
}

export async function oauthClient(origin, tokenFile, request) {
  if (!tokenFile) throw new Error(usage);
  const raw = (await readFile(tokenFile, "utf8")).trim();
  let credentials = raw.startsWith("{") ? JSON.parse(raw) : { access_token: raw };
  if (typeof credentials.access_token !== "string" || !credentials.access_token.trim()) throw new Error("Token file must contain an access token or OAuth JSON with access_token");
  const refresh = async () => {
      const refreshed = await request(origin + "/api/auth/oauth2/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh_token, client_id: credentials.client_id, resource: origin + "/mcp" }),
      });
      if (!refreshed.ok) throw new Error(`OAuth refresh failed (HTTP ${refreshed.status}); reconnect the existing authorization`);
      const tokens = await refreshed.json();
      if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("Invalid OAuth refresh response");
      credentials = { ...credentials, ...tokens };
      const temporary = `${tokenFile}.${randomUUID()}.tmp`;
      await save(temporary, credentials);
      await rename(temporary, tokenFile);
      await chmod(tokenFile, 0o600);
  };
  const api = async (path, body, retried = false) => {
    const response = await request(origin + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${credentials.access_token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && !retried && credentials.refresh_token && credentials.client_id) {
      await refresh();
      return api(path, body, true);
    }
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`.trim());
    return response.json();
  };
  return api;
}

async function loadTransfer(file) {
  const backup = JSON.parse(await readFile(file, "utf8"));
  const transfer = backup.format === "outfitter-wiki-transfer-v1" ? backup : backup.data?.transfer;
  if (!transfer) throw new Error("Backup has no portable transfer document; inspect data.transferLimitations and relink canonical references separately");
  if (Buffer.byteLength(JSON.stringify({ transfer, previewToken: "0".repeat(64) })) > 4_000_000) throw new Error("Transfer exceeds the API's 4,000,000-byte import limit");
  return { transfer, transferLimitations: backup.data?.transferLimitations ?? [] };
}

async function applyImport(api, destination, base, query, planFile, transfer, log) {
  const checked = value => checkDestination(value, destination);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  if (JSON.stringify(plan.destination) !== JSON.stringify(destination) || plan.documentHash !== digest(transfer)) throw new Error("User, destination or document changed; create and review a new preview");
  const previewToken = plan.preview?.data?.previewToken;
  if (!/^[a-f0-9]{64}$/.test(previewToken)) throw new Error("Invalid saved preview token");
  // Preserve a private backup before the write. A repeated command never overwrites evidence.
  const beforeFile = `${planFile}.before-${randomUUID()}.local.json`;
  await save(beforeFile, checked(await api(base + "export" + query)));
  const result = checked(await api(base + "import" + query, { transfer, previewToken }));
  const receiptFile = `${planFile}.receipt-${randomUUID()}.local.json`;
  await save(receiptFile, { ...result, beforeFile });
  log(JSON.stringify({ status: "imported", ...destination, beforeFile, receiptFile, result: result.data }));
}

function checkDestination(value, destination) {
  if (value.installationId !== destination.installationId || value.organizationId !== destination.organizationId) throw new Error("Response destination does not match the selected wiki");
  return value;
}

export async function runWikiTransfer(args, { tokenFile = process.env.OUTFITTER_ACCESS_TOKEN_FILE, fetch: request = globalThis.fetch, log = console.log } = {}) {
  const { command, origin, file, options } = parseArguments(args);
  const api = await oauthClient(origin, tokenFile, request);
  const identity = await api("/api/whoami");
  if (!identity.user?.id) throw new Error("No current user returned");
  const destination = { origin, installationId: options["--installation-id"], organizationId: options["--organization-id"] ?? null, userId: identity.user.id };
  const checked = value => checkDestination(value, destination);
  const base = `/api/app-installations/${encodeURIComponent(destination.installationId)}/wiki/`;
  const query = destination.organizationId ? `?organizationId=${encodeURIComponent(destination.organizationId)}` : "";
  if (command === "export") {
    const backup = checked(await api(base + "export" + query));
    await save(file, { ...backup, exportedAt: new Date().toISOString(), origin });
    log(JSON.stringify({ status: "exported", ...destination, file }));
    return;
  }
  const { transfer, transferLimitations } = await loadTransfer(file);
  if (command === "preview") {
    const preview = checked(await api(base + "preview" + query, transfer));
    if (!/^[a-f0-9]{64}$/.test(preview.data?.previewToken)) throw new Error("Invalid preview response");
    await save(options["--plan"], { destination, documentHash: digest(transfer), transferLimitations, preview });
    log(JSON.stringify({ status: "preview", ...destination, plan: options["--plan"], transferLimitations, ...preview.data }));
    return;
  }
  await applyImport(api, destination, base, query, options["--plan"], transfer, log);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWikiTransfer(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
