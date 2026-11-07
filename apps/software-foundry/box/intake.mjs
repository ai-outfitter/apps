// Request intake for the Foundry box. Each /in/requests/*.json work request
// (apps/software-foundry/box/schemas/work-request.schema.json)
// becomes one issue on the box's Forgejo, and Software Foundry's operator
// `start` launches its issue-to-merge workflow. A retry finds the issue an
// earlier attempt wrote by its request marker, and Foundry's own run id for an
// issue is deterministic, so rerunning intake never starts duplicate work.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const criterionId = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Each check is [passes, message]; the first that fails names the request. */
function check(name, checks) {
  const failed = checks.find(([passes]) => !passes);
  if (failed) throw new Error(`${name}: ${failed[1]}`);
}
const text = (value) => typeof value === "string" && value.trim().length > 0;

/** The request fields intake relies on; the full schema lives with the app. */
export function parseRequest(value, name = "request") {
  check(name, [[value && typeof value === "object" && !Array.isArray(value), "must be a JSON object"]]);
  const criteria = value.acceptanceCriteria;
  check(name, [
    [value.schemaVersion === 1, "schemaVersion must be 1"],
    [typeof value.requestId === "string" && uuid.test(value.requestId), "requestId must be a UUID"],
    [["feature", "bug"].includes(value.kind), "kind must be feature or bug"],
    [text(value.title) && value.title.length <= 200, "title needs 1 to 200 characters"],
    [text(value.problem), "problem is required"],
    [Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 50, "acceptanceCriteria needs 1 to 50 entries"],
  ]);
  check(name, [
    [criteria.every((criterion) => criterionId.test(criterion?.id ?? "") && text(criterion.text)), "each acceptance criterion needs an id and text"],
    [new Set(criteria.map((criterion) => criterion.id)).size === criteria.length, "criterion ids must be unique"],
    [(value.kind === "bug") === Boolean(value.bug), "bug details go with bug requests only"],
  ]);
  return { ...value, requestId: value.requestId.toLowerCase(), delivery: value.delivery ?? "pull_request" };
}

export const requestMarker = (requestId) => `<!-- foundry-box-request:${requestId} -->`;

/** The issue body Foundry triages: the problem, bug details and the criteria by id. */
export function issueBody(request) {
  const lines = [request.problem.trim(), ""];
  if (request.bug) {
    lines.push("## Steps to reproduce", "", ...request.bug.stepsToReproduce.map((step, index) => `${index + 1}. ${step}`), "");
    lines.push("## Expected", "", request.bug.expected, "", "## Actual", "", request.bug.actual, "");
    if (request.bug.environment) lines.push("## Environment", "", request.bug.environment, "");
  }
  lines.push("## Acceptance criteria", "", ...request.acceptanceCriteria.map((criterion) => `- [ ] \`${criterion.id}\`: ${criterion.text}`), "");
  if (request.constraints?.paths?.length) lines.push("## Paths", "", ...request.constraints.paths.map((path) => `- \`${path}\``), "");
  lines.push(`Delivery: ${request.delivery}. Kind: ${request.kind}.`, "", requestMarker(request.requestId));
  return lines.join("\n");
}

/** Every request file in a folder, in name order. */
export function readRequests(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.map((name) => ({ name, request: parseRequest(JSON.parse(readFileSync(join(directory, name), "utf8")), name) }));
}

/**
 * Files the request's issue once and starts Foundry on it.
 * `forgejo(method, path, body)` calls Forgejo's /api/v1 as the platform bot;
 * `operator(input)` posts a Software Foundry operator request.
 */
export async function submitRequest(request, { forgejo, operator, repository }) {
  const marker = requestMarker(request.requestId);
  const recent = await forgejo("GET", `/repos/${repository}/issues?state=all&type=issues&limit=50`);
  const found = recent.find((issue) => issue.body?.includes(marker));
  const issue = found ?? await forgejo("POST", `/repos/${repository}/issues`, {
    title: request.title,
    body: issueBody(request),
  });
  const run = await operator({ operation: "start", repository, number: issue.number });
  return { issue: { number: issue.number, url: issue.html_url, created: !found }, run };
}
