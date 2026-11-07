// Design results for the Workshop box: the bill of materials, each agent
// turn as an iteration, and the design-result document
// (box/schemas/design-result.schema.json) written to /out/results.

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
 *   model: { provider: string, id: string }, metrics?: any, error?: unknown, startedAt: string, finishedAt: string }} input
 */
export function designResult({ request, project, geometry, bom = [], files = [], commitSha, model, metrics, error, startedAt, finishedAt }) {
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
    ...(metrics ? { metrics } : {}),
    startedAt,
    finishedAt,
  };
}

