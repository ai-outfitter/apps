// Workshop's driver for the box (box/). The supervisor starts the services and
// the platform with Workshop installed, then calls run(): sign in as the local
// member, and for each design request have Workshop's design agent make the
// project (the first message, then each follow-up), build the model with the
// app's own geometry (export.ts: STEP and STL), store the files in RustFS,
// commit the design revision to the default branch under designs/<slug>/,
// write its design-result, and release the designs that asked for one.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { git, sha256 } from "../../../box/lib.mjs";
import { runMetrics, stepMetrics } from "../../../box/metrics.mjs";
import { readRequests } from "./intake.mjs";
import { releaseDesigns } from "./release.mjs";
import { billOfMaterials, designResult, exportSummary } from "./results.mjs";

export const app = "workshop";
export const title = "Workshop box";
/** The design agent calls the model from the platform, not from a workspace. */
export const platformModel = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTHOR = { name: "Outfitter Workshop", email: "outfitter@box.local" };
/** The box's local member (the webapp's src/lib/local-dev-login.ts). */
const MEMBER = { email: "local@example.test", password: "local-orgs-only" };

/** A request to the platform on loopback, addressed to one of its hostnames. */
function platformRequest(box, host, path, { method = "GET", body, cookie } = {}) {
  const origin = `http://${host}:${box.port}`;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port: box.port, path, method,
      headers: { Host: `${host}:${box.port}`, Origin: origin, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 300_000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error(`${method} ${path} timed out`)));
    request.on("error", reject);
    request.end(payload);
  });
}

/** Signs in as the local member and returns the session cookie. */
async function signIn(box) {
  const response = await platformRequest(box, "outfitter.localhost", "/api/auth/sign-in/email", { method: "POST", body: MEMBER });
  if (response.status !== 200) throw new Error(`Signing in failed (${response.status}): ${response.text.slice(0, 300)}`);
  const cookie = [response.headers["set-cookie"] ?? []].flat().map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Signing in returned no session cookie");
  return cookie;
}

/** One turn with Workshop's design agent; it saves the project and returns it. */
async function designTurn(box, cookie, body) {
  const response = await platformRequest(box, "workshop.box.outfitter.localhost", "/api/apps/workshop/agent", { method: "POST", body, cookie });
  if (response.status !== 200) throw new Error(`The design agent answered ${response.status}: ${response.text.slice(0, 500)}`);
  return JSON.parse(response.text).project;
}

/** The design agent's model calls between two times, from the platform's usage records (none without the database). */
async function modelCalls(platform, from, to) {
  if (!platform) return [];
  const { rows } = await platform.execute({
    sql: "SELECT inputTokens, outputTokens FROM inference_usage_records WHERE workloadKind='workshop' AND createdAt BETWEEN ? AND ? ORDER BY createdAt",
    args: [from, to] });
  return rows.map((row) => ({ input: row.inputTokens === null ? null : Number(row.inputTokens), output: row.outputTokens === null ? null : Number(row.outputTokens) }));
}

/** Runs one step of a design and records its time and model calls, whether it succeeds or not. */
async function timed(steps, platform, name, work) {
  const startedAt = Date.now();
  let status = "failed";
  try {
    const value = await work();
    status = "succeeded";
    return value;
  } finally {
    const finishedAt = Date.now();
    const calls = await modelCalls(platform, startedAt, finishedAt).catch(() => []);
    steps.push(stepMetrics({ name, status, startedAt, finishedAt, calls }));
  }
}

/** Builds the project's model and writes its files to a folder. */
function exportDesign(project, folder) {
  writeFileSync(join(folder, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "export.ts"), join(folder, "project.json"), folder],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Building the model failed: ${(result.stderr || result.stdout).slice(-1000)}`);
  return exportSummary(result.stdout);
}

/** @param {any} box the supervisor's driver context */
export async function run(box) {
  const requests = readRequests(box.requests);
  const work = mkdtempSync(join(tmpdir(), "workshop-box-"));
  const repo = join(work, "repo");
  git(work, ["clone", "--quiet", "--branch", box.defaultBranch, box.remote, "repo"]);
  const cookie = await signIn(box);
  const platform = box.databases?.platform ? createClient({ url: `file:${box.databases.platform}` }) : undefined;
  const finished = [];
  for (const { name, request } of requests) {
    const startedAt = new Date().toISOString();
    let project, exported, bom = [], files = [], commitSha, error;
    const steps = [];
    try {
      project = await timed(steps, platform, "design", () => designTurn(box, cookie, { message: request.message }));
      for (const [index, message] of request.followUps.entries())
        project = await timed(steps, platform, `follow-up ${index + 1}`,
          () => designTurn(box, cookie, { message, projectId: project.id, revision: project.revision }));
      const folder = join(repo, "designs", request.slug);
      mkdirSync(folder, { recursive: true });
      exported = await timed(steps, platform, "export", async () => exportDesign(project, folder));
      bom = billOfMaterials(project, exported);
      writeFileSync(join(folder, "bom.json"), `${JSON.stringify(bom, null, 2)}\n`);
      // The files are stored before the commit is pushed, so a failed design never reaches the branch.
      for (const file of ["project.json", "model.step", "model.stl", "bom.json"]) {
        const bytes = readFileSync(join(folder, file));
        files.push({ path: `designs/${request.slug}/${file}`, sha256: sha256(bytes), bytes: bytes.length,
          uri: await box.store(`designs/${request.requestId}/${file}`, bytes, file.endsWith(".json") ? "application/json" : "application/octet-stream") });
      }
      // The design revision: one commit on the default branch.
      git(repo, ["add", "-A", join("designs", request.slug)]);
      git(repo, ["commit", "--quiet", "-m", `design: ${request.title}\n\nWorkshop project ${project.id} at revision ${project.revision}.\nBox request ${request.requestId}.`], { author: AUTHOR });
      git(repo, ["push", "--quiet", "origin", `HEAD:${box.defaultBranch}`]);
      commitSha = git(repo, ["rev-parse", "HEAD"]).toString().trim();
    } catch (caught) {
      error = caught;
      commitSha = undefined;
      // A failed design leaves nothing behind for the next one.
      git(repo, ["reset", "--quiet", "--hard", `origin/${box.defaultBranch}`]);
      git(repo, ["clean", "-fdq"]);
    }
    const geometry = exported && { bounds: exported.bounds, volumeMm3: exported.volumeMm3, features: exported.features };
    const finishedAt = new Date().toISOString();
    const result = designResult({ request, project, geometry, bom, files, commitSha, model: box.model, error,
      metrics: runMetrics(steps, { startedAt, finishedAt }), startedAt, finishedAt });
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify(result, null, 2)}\n`);
    finished.push({ request, result });
    box.log(`${name}: ${result.status}${commitSha ? ` at ${commitSha.slice(0, 8)}` : ` (${result.reason})`}`);
  }
  release(box, finished).then(() => box.finish(), (failure) => box.finish(failure));
}

/** Releases the designs that asked for one. */
async function release(box, finished) {
  const designed = finished.filter(({ request, result }) => request.release?.trigger && result.status === "designed");
  if (!designed.length) return;
  const release = await releaseDesigns(box, designed);
  for (const { request, result } of designed)
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify({ ...result, release }, null, 2)}\n`);
}
