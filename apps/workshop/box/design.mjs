// The Workshop box's request and result documents (src/box/contract.ts): the
// request fields the driver relies on, the bill of materials for a design,
// the design-result document and a release's evidence bundle.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../../../box/lib.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const message = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 500;

/** Each check is [passes, message]; the first that fails names the request. */
function check(name, checks) {
  const failed = checks.find(([passes]) => !passes);
  if (failed) throw new Error(`${name}: ${failed[1]}`);
}

/** The request fields the driver relies on; the full schema lives in box/schemas. */
export function parseRequest(value, name = "request") {
  check(name, [[value && typeof value === "object" && !Array.isArray(value), "must be a JSON object"]]);
  const followUps = value.followUps ?? [];
  check(name, [
    [value.schemaVersion === 1, "schemaVersion must be 1"],
    [typeof value.requestId === "string" && uuid.test(value.requestId), "requestId must be a UUID"],
    [typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 200, "title needs 1 to 200 characters"],
    [message(value.message), "message needs 1 to 500 characters"],
    [Array.isArray(followUps) && followUps.length <= 8 && followUps.every(message), "followUps are up to 8 messages of 1 to 500 characters"],
    [value.slug === undefined || slug.test(value.slug), "slug must be a lowercase slug"],
  ]);
  return {
    ...value,
    requestId: value.requestId.toLowerCase(),
    message: value.message.trim(),
    followUps: followUps.map((text) => text.trim()),
    slug: value.slug ?? slugify(value.title),
  };
}

/** Every request file in a folder, in name order; two requests may not share a folder. */
export function readRequests(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const requests = names.map((name) => ({ name, request: parseRequest(JSON.parse(readFileSync(join(directory, name), "utf8")), name) }));
  const slugs = requests.map(({ request }) => request.slug);
  const duplicate = slugs.find((value, index) => slugs.indexOf(value) !== index);
  if (duplicate) throw new Error(`Two requests design into designs/${duplicate}; give one a slug`);
  return requests;
}

/** The design's bill of materials: its modeled body, then the parts of the
 * project's assembly (export.ts reads them with the app's bomTotals). */
export function billOfMaterials(project, exported) {
  return [
    { part: project.name, quantity: 1, kind: "fabricated", volumeMm3: exported.volumeMm3, bounds: exported.bounds },
    ...(exported.parts ?? []).map((line) => ({ ...line, part: String(line.part).slice(0, 200) })),
  ];
}

/** The export's summary: the last line export.ts prints. */
export function exportSummary(stdout) {
  const line = stdout.trim().split("\n").pop() ?? "";
  const summary = JSON.parse(line);
  if (!summary?.bounds || !(summary.volumeMm3 > 0)) throw new Error("The model export reported no geometry");
  return summary;
}

/** Each agent turn as a design iteration. */
export const designIterations = (project) =>
  (project.iterations ?? []).map((item) => ({
    message: item.prompt,
    rationale: item.rationale ?? "",
    dimensions: item.dimensions ?? item.size,
    revision: item.revision,
  }));

/**
 * The design-result document for a request.
 * @param {{ request: any, project?: any, geometry?: any, bom?: any[], files?: any[], commitSha?: string,
 *   model: { provider: string, id: string }, error?: unknown, startedAt: string, finishedAt: string }} input
 */
export function designResult({ request, project, geometry, bom = [], files = [], commitSha, model, error, startedAt, finishedAt }) {
  const designed = !error && project && geometry && commitSha;
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    status: designed ? "designed" : "failed",
    ...(designed ? {} : { reason: String(/** @type {any} */ (error)?.message ?? error ?? "The design did not finish").slice(0, 4000) }),
    path: `designs/${request.slug}`,
    ...(project ? { project: { id: project.id, revision: project.revision, name: project.name } } : {}),
    iterations: project ? designIterations(project) : [],
    ...(geometry ? { geometry } : {}),
    bom,
    files,
    ...(commitSha ? { commitSha } : {}),
    model,
    startedAt,
    finishedAt,
  };
}

/**
 * The evidence bundle: what was released from which commit, and the files behind each design.
 * @param {{ tag: string, version: string, commitSha: string, build: any, model: any, designed: { request?: any, result: any }[], artifacts: any[] }} input
 */
export function evidenceBundle({ tag, version, commitSha, build, model, designed, artifacts }) {
  return {
    schemaVersion: 1,
    tag,
    version,
    commitSha,
    build,
    model,
    designs: designed.map(({ result }) => ({
      requestId: result.requestId,
      path: result.path,
      commitSha: result.commitSha,
      projectRevision: result.project.revision,
      geometry: { bounds: result.geometry.bounds, volumeMm3: result.geometry.volumeMm3 },
      files: result.files,
    })),
    artifacts,
  };
}
