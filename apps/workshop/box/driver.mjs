// Workshop's driver for the box (box/). The supervisor starts the services and
// the platform with Workshop installed, then calls run(). For each design
// request it signs in as the local member, has Workshop's design agent make
// the project (the first message, then each follow-up), builds the model with
// the app's own geometry (export.ts: STEP and STL), commits the design
// revision to the box repository's default branch under designs/<slug>/,
// stores its files in RustFS and writes /out/results/<requestId>.json. Then it
// releases the designs that asked for one, with an evidence bundle.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, nextVersion, sha256 } from "../../../box/lib.mjs";
import { billOfMaterials, designResult, evidenceBundle, exportSummary, readRequests } from "./design.mjs";

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
  const finished = [];
  for (const { name, request } of requests) {
    const startedAt = new Date().toISOString();
    let project, exported, bom = [], files = [], commitSha, error;
    try {
      project = await designTurn(box, cookie, { message: request.message });
      for (const message of request.followUps)
        project = await designTurn(box, cookie, { message, projectId: project.id, revision: project.revision });
      const folder = join(repo, "designs", request.slug);
      mkdirSync(folder, { recursive: true });
      exported = exportDesign(project, folder);
      bom = billOfMaterials(project, exported);
      writeFileSync(join(folder, "bom.json"), `${JSON.stringify(bom, null, 2)}\n`);
      // The design revision: one commit on the default branch.
      git(repo, ["add", "-A", join("designs", request.slug)]);
      git(repo, ["commit", "--quiet", "-m", `design: ${request.title}\n\nWorkshop project ${project.id} at revision ${project.revision}.\nBox request ${request.requestId}.`], { author: AUTHOR });
      git(repo, ["push", "--quiet", "origin", `HEAD:${box.defaultBranch}`]);
      commitSha = git(repo, ["rev-parse", "HEAD"]).toString().trim();
      for (const file of ["project.json", "model.step", "model.stl", "bom.json"]) {
        const bytes = readFileSync(join(folder, file));
        const path = `designs/${request.slug}/${file}`;
        files.push({ path, sha256: sha256(bytes), bytes: bytes.length,
          uri: await box.store(`designs/${request.requestId}/${file}`, bytes, file.endsWith(".json") ? "application/json" : "application/octet-stream") });
      }
    } catch (caught) {
      error = caught;
      // A failed design leaves nothing half-committed in the next one.
      git(repo, ["reset", "--quiet", "--hard", `origin/${box.defaultBranch}`]);
      git(repo, ["clean", "-fdq"]);
    }
    const geometry = exported && { bounds: exported.bounds, volumeMm3: exported.volumeMm3, features: exported.features };
    const result = designResult({ request, project, geometry, bom, files, commitSha, model: box.model, error,
      startedAt, finishedAt: new Date().toISOString() });
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify(result, null, 2)}\n`);
    finished.push({ request, result });
    box.log(`${name}: ${result.status}${commitSha ? ` at ${commitSha.slice(0, 8)}` : ` (${result.reason})`}`);
  }
  release(box, repo, finished).then(() => box.finish(), (failure) => box.finish(failure));
}

/** Tags the designs that asked for a release, stores the release artifacts and
 * evidence bundle in RustFS, and publishes a Forgejo release linking them. */
async function release(box, repo, finished) {
  const designed = finished.filter(({ request, result }) => request.release?.trigger && result.status === "designed");
  if (!designed.length) return;
  const startedAt = new Date().toISOString();
  git(repo, ["fetch", "--quiet", "--tags", "origin"]);
  const commitSha = git(repo, ["rev-parse", `origin/${box.defaultBranch}`]).toString().trim();
  const tags = git(repo, ["tag", "--list"]).toString().split("\n").filter(Boolean);
  const version = nextVersion(tags, designed.map(({ request }) => request.release?.bump ?? "patch"));
  const tag = `v${version}`;
  const name = box.repository.split("/")[1];
  const archive = git(repo, ["archive", "--format=tar.gz", `--prefix=${name}-${version}/`, commitSha]);
  const directory = join(box.out, "release", tag);
  mkdirSync(directory, { recursive: true });
  const archiveName = `${name}-${version}.tar.gz`;
  writeFileSync(join(directory, archiveName), archive);
  const artifacts = [{ name: archiveName, uri: await box.store(`releases/${tag}/${archiveName}`, archive, "application/gzip"), sha256: sha256(archive), bytes: archive.length }];
  const bundle = evidenceBundle({ tag, version, commitSha, model: box.model, designed, artifacts,
    build: { command: `git archive ${commitSha}; node export.ts per design`, image: box.image, startedAt, finishedAt: new Date().toISOString() } });
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(directory, "evidence-bundle.json"), bundleBytes);
  const evidence = { uri: await box.store(`releases/${tag}/evidence-bundle.json`, bundleBytes, "application/json"), sha256: sha256(bundleBytes) };
  const notes = [
    `Release ${tag} of ${box.repository} at ${commitSha}.`, "",
    ...designed.map(({ request, result }) => `- ${request.title}: ${result.path} (${result.geometry.bounds.width} x ${result.geometry.bounds.depth} x ${result.geometry.bounds.height} mm)`), "",
    `Evidence bundle: ${evidence.uri} (sha256 ${evidence.sha256})`,
    ...artifacts.map((artifact) => `Artifact: ${artifact.name}, ${artifact.uri} (sha256 ${artifact.sha256})`),
  ].join("\n");
  const published = await box.forgejo("POST", `/repos/${box.repository}/releases`, { tag_name: tag, target_commitish: commitSha, name: tag, body: notes });
  const releaseResult = { tag, url: published.html_url, artifacts, evidenceBundle: evidence };
  for (const { request, result } of designed)
    writeFileSync(join(box.out, "results", `${request.requestId}.json`), `${JSON.stringify({ ...result, release: releaseResult }, null, 2)}\n`);
  box.log(`released ${tag}: ${published.html_url}`);
}
