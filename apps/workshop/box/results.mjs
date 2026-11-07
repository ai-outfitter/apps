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
 *   model: { provider: string, id: string }, metrics?: any, sessions?: any, error?: unknown, startedAt: string, finishedAt: string }} input
 */
export function designResult({ request, project, geometry, bom = [], files = [], commitSha, model, metrics, sessions, error, startedAt, finishedAt }) {
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
    ...(sessions ? { sessions } : {}),
    startedAt,
    finishedAt,
  };
}


/**
 * The design agent's turns as one pi-format session (box/sessions.mjs), so the
 * platform-side agent is recorded the same way as the agents in workspaces.
 * @param {{ requestId: string, model: { provider: string, id: string }, turns: { message: string, startedAt: number, finishedAt: number,
 *   calls: { input: number | null, output: number | null }[], response?: { rationale?: string, project?: any }, error?: unknown }[] }} input
 */
export function designSession({ requestId, model, turns }) {
  const iso = (ms) => new Date(ms).toISOString();
  const sum = (values) => (values.length && values.every((value) => value !== null) ? values.reduce((total, value) => total + value, 0) : undefined);
  const entries = [{ type: "session", version: 3, id: requestId, timestamp: iso(turns[0]?.startedAt ?? Date.now()), cwd: "workshop" }];
  for (const turn of turns) {
    entries.push({ type: "message", timestamp: iso(turn.startedAt),
      message: { role: "user", content: [{ type: "text", text: turn.message }], timestamp: turn.startedAt } });
    const input = sum(turn.calls.map((call) => call.input));
    const output = sum(turn.calls.map((call) => call.output));
    const plan = turn.response?.project && { name: turn.response.project.name, revision: turn.response.project.revision,
      params: turn.response.project.params, cadPlan: turn.response.project.cadPlan };
    entries.push({ type: "message", timestamp: iso(turn.finishedAt),
      message: { role: "assistant", provider: model.provider, model: model.id, timestamp: turn.finishedAt,
        content: turn.response
          ? [{ type: "text", text: turn.response.rationale ?? "" }, { type: "text", text: `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` }]
          : [],
        usage: { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
          ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}), calls: turn.calls.length },
        stopReason: turn.response ? "stop" : "error",
        ...(turn.response ? {} : { errorMessage: String(/** @type {any} */ (turn.error)?.message ?? turn.error ?? "The turn failed").slice(0, 1000) }) } });
  }
  return entries;
}
