// Workshop's driver for the box (box/). The supervisor starts the services and
// the platform with Workshop installed, then calls run(): sign in as the local
// member, and for each design request have Workshop's design agent make the
// project (the first message, then each follow-up), build the model with the
// app's own geometry (export.ts: STEP and STL), store the files in RustFS,
// commit the design revision to the default branch under designs/<slug>/,
// write its design-result, and release the designs that asked for one. After
// each design turn it screenshots the project's workbench (screenshots.mjs).
// A request with `via: "graphql"` reaches the same design agent another way:
// each turn is started with the StartWorkshopDesign mutation through the
// platform's graph API (MCP graph_mutate) and its run is followed to the end.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { git, sha256 } from "../../../box/lib.mjs";
import { runMetrics, stepMetrics } from "../../../box/metrics.mjs";
import { recordSessions } from "../../../box/sessions.mjs";
import { readRequests } from "./intake.mjs";
import { releaseDesigns } from "./release.mjs";
import { billOfMaterials, designResult, designSession, exportSummary } from "./results.mjs";
import { openWorkbench, screenshotName } from "./screenshots.mjs";

export const app = "workshop";
export const title = "Workshop box";
/** The design agent asks the platform for each model answer (the workflow host's
 * inference.generate), not a workspace, so the platform gets the model settings. */
export const platformModel = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTHOR = { name: "Outfitter Workshop", email: "outfitter@box.local" };
/** The box's local member (the webapp's src/lib/local-dev-login.ts). */
const MEMBER = { email: "local@example.test", password: "local-orgs-only" };

/** A request to the platform on loopback, addressed to one of its hostnames. */
export function platformRequest(box, host, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const origin = `http://${host}:${box.port}`;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port: box.port, path, method,
      headers: { Host: `${host}:${box.port}`, Origin: origin, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers },
      // A design turn on a slow local model can take up to the step's 14-minute inference limit.
      timeout: 900_000,
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
export async function signIn(box) {
  const response = await platformRequest(box, "outfitter.localhost", "/api/auth/sign-in/email", { method: "POST", body: MEMBER });
  if (response.status !== 200) throw new Error(`Signing in failed (${response.status}): ${response.text.slice(0, 300)}`);
  const cookie = [response.headers["set-cookie"] ?? []].flat().map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Signing in returned no session cookie");
  return cookie;
}

/** One turn with Workshop's design agent; it saves the project and returns it with the agent's rationale. */
async function designTurn(box, cookie, body) {
  const response = await platformRequest(box, "workshop.box.outfitter.localhost", "/api/apps/workshop/agent", { method: "POST", body, cookie });
  if (response.status !== 200) throw new Error(`The design agent answered ${response.status}: ${response.text.slice(0, 500)}`);
  const { project, rationale } = JSON.parse(response.text);
  return { project, rationale };
}

/** The box organization's slug: the scope its apps answer under in the graph API. */
const SCOPE = "box";
/** How long a started design run is followed: the design step's 14-minute inference limit, and a minute. */
const RUN_TIMEOUT_MS = 900_000;

/** One tool call on the platform's MCP dispatch, signed in as the member: the local session adapter serves the
 * same graph_documents, graph_query and graph_mutate that /mcp serves an OAuth client. Answers the tool's JSON. */
export async function graphTool(box, cookie, name, args) {
  const response = await platformRequest(box, "outfitter.localhost", "/debug/mcp/rpc", { method: "POST", cookie,
    headers: { Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  if (response.status !== 200) throw new Error(`${name} answered ${response.status}: ${response.text.slice(0, 500)}`);
  // A JSON body, or one event of an event stream.
  const json = response.text.trimStart().startsWith("{") ? response.text
    : response.text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  const reply = JSON.parse(json);
  if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
  const text = reply.result?.content?.find((part) => part.type === "text")?.text ?? "";
  if (reply.result?.isError) throw new Error(`${args.document ?? name} was refused: ${text.slice(0, 500)}`);
  const answer = JSON.parse(text);
  if (answer?.errors?.length) throw new Error(`${args.document ?? name}: ${String(answer.errors[0].message).slice(0, 500)}`);
  return answer;
}

/** The first value under `key` anywhere in a tool's answer: a mutation answers data.<field>, a query one entry per installation. */
function answered(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value) return value[key];
  for (const child of Object.values(value)) {
    const found = answered(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Why a started run failed, from the platform's TaskRuns; the run itself only says that it did. */
async function runFailure(box, cookie, id) {
  try {
    const runs = await graphTool(box, cookie, "graph_query", { scope: "platform", app: "platform", document: "TaskRuns",
      variables: { target: { scope: SCOPE, app }, ids: [id] }, includeIdentifiers: true });
    const error = answered(runs, "error");
    return typeof error === "string" && error ? error : "The design run failed";
  } catch {
    return "The design run failed";
  }
}

/** One turn started through the graph API: the StartWorkshopDesign mutation, then its run read until it
 * finishes, then the project it saved. Answers what the design route answers. */
async function designRun(box, cookie, body) {
  const id = crypto.randomUUID();
  const started = answered(await graphTool(box, cookie, "graph_mutate", { scope: SCOPE, app, document: "StartWorkshopDesign", variables: { input: { id, ...body } } }), "startWorkshopDesign");
  if (started?.id !== id) throw new Error("StartWorkshopDesign did not answer the run it started");
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let run = started;
  while (run.status === "running") {
    if (Date.now() > deadline) throw new Error(`Design run ${id} was still running after ${RUN_TIMEOUT_MS / 60_000} minutes`);
    await new Promise((resolve) => setTimeout(resolve, box.pollMs ?? 2000));
    // Identifiers are asked for: the run's design carries the project id and revision.
    run = answered(await graphTool(box, cookie, "graph_query", { scope: SCOPE, app, document: "WorkshopDesignRun", variables: { input: { id } }, includeIdentifiers: true }), "workshopDesignRun");
    if (!run) throw new Error(`WorkshopDesignRun did not answer run ${id}`);
  }
  if (run.status !== "complete" || !run.design?.projectId) throw new Error(await runFailure(box, cookie, id));
  const response = await platformRequest(box, "workshop.box.outfitter.localhost", `/api/apps/workshop/projects/${run.design.projectId}`, { cookie });
  if (response.status !== 200) throw new Error(`Reading the designed project answered ${response.status}: ${response.text.slice(0, 300)}`);
  const project = JSON.parse(response.text);
  if (project.revision !== run.design.revision) throw new Error(`The project is at revision ${project.revision}, not the run's ${run.design.revision}`);
  return { project, rationale: project.iterations?.at(-1)?.rationale ?? "" };
}

/** The design agent's model calls between two times, from the platform's usage records for
 * workflow runs (none without the database). The box runs nothing else that meters to a workflow. */
async function modelCalls(platform, from, to) {
  if (!platform) return [];
  const { rows } = await platform.execute({
    sql: "SELECT inputTokens, outputTokens FROM inference_usage_records WHERE workloadKind='workflow' AND createdAt BETWEEN ? AND ? ORDER BY createdAt",
    args: [from, to] });
  return rows.map((row) => ({ input: row.inputTokens === null ? null : Number(row.inputTokens), output: row.outputTokens === null ? null : Number(row.outputTokens) }));
}

/** Runs one step of a design and records its time and model calls, whether it succeeds or not.
 * A design turn (`message`) is also added to the request's session turns. */
async function timed({ steps, turns, platform }, name, work, message) {
  const startedAt = Date.now();
  let status = "failed", value, error;
  try {
    value = await work();
    status = "succeeded";
    return value;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    const finishedAt = Date.now();
    const calls = await modelCalls(platform, startedAt, finishedAt).catch(() => []);
    steps.push(stepMetrics({ name, status, startedAt, finishedAt, calls }));
    if (message !== undefined) turns.push({ message, startedAt, finishedAt, calls, ...(error ? { error } : { response: value }) });
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

/** Screenshots the project's workbench after a step into /out/screenshots/<requestId>/ and RustFS.
 * A screenshot that fails is logged; the design goes on without it. */
async function screenshot(box, workbench, request, shots, step, project) {
  if (!workbench) return;
  try {
    const { png, ready } = await workbench.capture(project);
    const name = screenshotName(shots.length + 1, step);
    const path = join("screenshots", request.requestId, name);
    mkdirSync(join(box.out, "screenshots", request.requestId), { recursive: true });
    writeFileSync(join(box.out, path), png);
    shots.push({ step, revision: project.revision, path, sha256: sha256(png), bytes: png.length, ready,
      uri: await box.store(`designs/${request.requestId}/screenshots/${name}`, png, "image/png") });
  } catch (error) {
    box.log(`${request.slug}: no screenshot after ${step} (${error.message})`);
  }
}

/** @param {any} box the supervisor's driver context */
export async function run(box) {
  if(box.env?.BOX_WORKSPACE === "1") {
    void (await import("./workspace-driver.mjs")).runWorkspace(box).catch(error=>box.finish(error));
    return;
  }
  const requests = readRequests(box.requests);
  const work = mkdtempSync(join(tmpdir(), "workshop-box-"));
  const repo = join(work, "repo");
  git(work, ["clone", "--quiet", "--branch", box.defaultBranch, box.remote, "repo"]);
  const cookie = await signIn(box);
  const platform = box.databases?.platform ? createClient({ url: `file:${box.databases.platform}` }) : undefined;
  const workbench = await openWorkbench(box, cookie);
  const finished = [];
  for (const { name, request } of requests) {
    const startedAt = new Date().toISOString();
    let project, exported, bom = [], files = [], shots = [], commitSha, error;
    const trace = { steps: [], turns: [], platform };
    try {
      // The same turns either way: posted to the design route, or started through the graph API.
      const turn = request.via === "graphql" ? designRun : designTurn;
      ({ project } = await timed(trace, "design", () => turn(box, cookie, { message: request.message }), request.message));
      await screenshot(box, workbench, request, shots, "design", project);
      for (const [index, message] of request.followUps.entries()) {
        ({ project } = await timed(trace, `follow-up ${index + 1}`,
          () => turn(box, cookie, { message, projectId: project.id, revision: project.revision }), message));
        await screenshot(box, workbench, request, shots, `follow-up ${index + 1}`, project);
      }
      const folder = join(repo, "designs", request.slug);
      mkdirSync(folder, { recursive: true });
      exported = await timed(trace, "export", async () => exportDesign(project, folder));
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
    // The design agent's session: in /out and on the repository's sessions branch.
    let sessions;
    try {
      if (trace.turns.length)
        sessions = recordSessions(box, request.requestId,
          [{ agent: "design-agent", entries: designSession({ requestId: request.requestId, model: box.model, turns: trace.turns }) }]);
    } catch (caught) {
      box.log(`${name}: sessions not recorded (${caught.message})`);
    }
    const result = designResult({ request, project, geometry, bom, files, screenshots: shots, commitSha, model: box.model, error, sessions,
      metrics: runMetrics(trace.steps, { startedAt, finishedAt }), startedAt, finishedAt });
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify(result, null, 2)}\n`);
    finished.push({ request, result });
    box.log(`${name}: ${result.status}${commitSha ? ` at ${commitSha.slice(0, 8)}` : ` (${result.reason})`}`);
  }
  await workbench?.close().catch(() => undefined);
  const {capturePreviews}=await import('./capture-previews.mjs');
  await capturePreviews({origin:`http://outfitter.localhost:${box.port}`,cookie,output:join(box.out,'visual-evidence'),log:box.log}).catch(error=>box.log(`Preview capture failed: ${error.message}`));
  release(box, finished).then(() => box.finish(), (failure) => box.finish(failure));
  if(!box.env.BOX_EXIT_WHEN_DONE) void (async()=>{
    while(true){await new Promise(resolve=>setTimeout(resolve,30000));await capturePreviews({origin:`http://outfitter.localhost:${box.port}`,cookie,output:join(box.out,'visual-evidence'),log:box.log}).catch(error=>box.log(`Preview capture failed: ${error.message}`));}
  })();
}

/** Releases the designs that asked for one. */
async function release(box, finished) {
  const designed = finished.filter(({ request, result }) => request.release?.trigger && result.status === "designed");
  if (!designed.length) return;
  const release = await releaseDesigns(box, designed);
  for (const { request, result } of designed)
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify({ ...result, release }, null, 2)}\n`);
}
