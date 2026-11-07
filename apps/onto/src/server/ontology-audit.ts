import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { scheduleInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import prompt from "../../agent/ontology-steward.md?raw";
import { auditOntology } from "../lib/ontology-validation";
import { readGraph } from "./graph";
import { finding } from "./batch-review";
import type { Database } from "./graph-batches";

export const auditWorkflow = "ontology-audit";
/** Called only by an editor's explicit action; the platform owns authorization and schedule. */
export async function enableAuditSchedule(host: WorkflowHost<"interactive">) {
  const audit = await host.call("schedule.save", { workflow: auditWorkflow, cron: "0 8 * * *", timezone: "UTC", inputs: {}, enabled: true });
  const reviews = await host.call("schedule.save", { workflow: "batch-review", cron: "0 */6 * * *", timezone: "UTC", inputs: {}, enabled: true });
  return { audit, reviews };
}
const answer = z.strictObject({ summary: z.string().max(1000), findings: z.array(finding).max(100) });
const schema = { type: "object", additionalProperties: false, required: ["summary", "findings"], properties: {
  summary: { type: "string", maxLength: 1000 }, findings: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
    required: ["ref", "rule", "severity", "message", "fix"], properties: { ref: { type: ["string", "null"] }, rule: { type: "string" }, severity: { enum: ["error", "warning", "note"] }, message: { type: "string" }, fix: { type: ["string", "null"] } } } },
} };
/** Executes only a member-owned schedule, using its reserved run and trusted identity. */
export async function auditOnSchedule(db: Database, who: AppIdentity, host: WorkflowHost<"schedule">, raw: PhaseInput): Promise<PhaseInput> {
  const { schedule, runId } = scheduleInput.parse(raw);
  if (schedule.workflowId !== auditWorkflow) return { outcome: "declined", reason: "Unknown scheduled workflow" };
  if (!who.canEdit) return { outcome: "declined", reason: "An editor must own the audit schedule" };
  const graph = await readGraph(db, who);
  const complete = graph.nodes.length <= 300 && graph.edges.length <= 600 && graph.types.length <= 300;
  const data = { mode: "audit", complete, types: graph.types.slice(0, 300), nodes: graph.nodes.slice(0, 300), edges: graph.edges.slice(0, 600), violations: auditOntology(graph).slice(0, 200) };
  await host.call("workflow.start", { workflow: auditWorkflow, id: runId, inputs: schedule.inputs });
  const generated = await host.call("inference.generate", { runId, step: "audit", instructions: prompt, data: JSON.parse(JSON.stringify(data)), schema });
  const result = answer.parse(generated.output);
  await host.call("workflow.collect", { runId, slot: "audit.outputs.findings", value: { ...result, complete } });
  return { outcome: "started" };
}
