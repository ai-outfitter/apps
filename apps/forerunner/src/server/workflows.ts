import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./items";
import { discoveryWorkflow } from "./schedule";
import { discoveryRecords } from "./schema";

// The Workflows page: everything that runs for the member, read and changed through
// the platform's own documents (Schedules, WorkflowRuns, ScheduleChanges and
// WorkflowRunChanges), the same ones the member's MCP client and sidebar agents use.
// Forerunner adds only names and, for its own discovery runs, the stage and run page.

type Target = { scope: string; app: string };
type ScheduleRow = {
  source: string; target: Target; workflowId: string; routine?: string; name?: string; cadence?: string; cron: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunId: string | null; lastRunStatus?: string | null; lastOutcome: string | null;
  createdBy?: string; canChange?: boolean;
};
type RunRow = { target: Target; run: string; workflow: string; status: string; scheduleId?: string; steps: { id: string; state: string }[]; createdAt: number; updatedAt: number };
type Page<T> = { items: T[] };

export type Workflow = {
  /** Which workflow this is, for the page: the routine id, or the app and workflow. */
  key: string;
  kind: "app" | "routine";
  target: Target;
  workflow: string;
  routine: string | null;
  name: string;
  cadence: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRun: { target: Target; run: string; status: string; href: string | null } | null;
  lastOutcome: string | null;
  canChange: boolean;
  canDelete: boolean;
};
export type WorkflowRun = {
  target: Target; run: string; name: string; status: string;
  /** A running run's step; for discovery, its stage: preparing, reading, analyzing, validating or saving. */
  stage: string | null;
  startedAt: number; updatedAt: number; href: string | null;
};

const RUN_LIMIT = 20;

/** One platform document, as the member: graph_query or graph_mutate at scope and app "platform". */
function platform<T>(host: WorkflowHost<"interactive">, document: string, variables: Record<string, unknown>, kind: "query" | "mutation" = "query") {
  return host.call("platform.document", { document, kind, variables: JSON.parse(JSON.stringify(variables)) }) as Promise<T>;
}

type Receipt = { key: string; status: string; error?: { message?: string } };
/** One change item through a platform change document; a refusal keeps its message. */
async function change(host: WorkflowHost<"interactive">, document: string, item: Record<string, unknown>) {
  const answer = await platform<{ items: Receipt[] }>(host, document, { items: [{ key: crypto.randomUUID(), ...item }] }, "mutation");
  const [receipt] = answer.items;
  if (!receipt || receipt.status === "failed" || receipt.status === "uncertain")
    throw new Response(receipt?.error?.message || "That did not work. Try again.", { status: 409 });
  return receipt;
}

const isDiscovery = (target: Target, workflow: string) => target.app === "forerunner" && workflow === discoveryWorkflow;
const words = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
const scopeNote = (target: Target) => (target.scope === "personal" ? "" : ` · ${target.scope}`);

function cadence(cron: string, timezone: string) {
  const [minute, hour, , , days] = cron.trim().split(/\s+/);
  const at = /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") ? ` at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "";
  return `${days === "*" ? "Every day" : cron}${at} ${timezone}`.trim();
}

/** Forerunner's discovery records for these platform runs: the run page id and current stage. */
async function discoveryRuns(db: Database, who: AppIdentity, runIds: string[]) {
  if (!runIds.length) return new Map<string, { id: string; status: string }>();
  const workflowRunId = sql<string>`json_extract(${discoveryRecords.data}, '$.workflowRunId')`;
  const rows = await db.select({ id: discoveryRecords.id, data: discoveryRecords.data, workflowRunId }).from(discoveryRecords)
    .where(and(eq(discoveryRecords.installationId, who.installationId), eq(discoveryRecords.ownerId, who.userId), eq(discoveryRecords.kind, "run"), inArray(workflowRunId, runIds)));
  return new Map(rows.map((row) => [row.workflowRunId, { id: row.id, status: String(JSON.parse(row.data).status ?? "") }]));
}

/** Where a run opens: Forerunner's own run page (relative to the app), or the main site's (absolute). */
function runHref(run: { target: Target; workflow: string; run: string }, discovery: Map<string, { id: string }>) {
  if (isDiscovery(run.target, run.workflow)) {
    const record = discovery.get(run.run);
    return record ? `runs/${encodeURIComponent(record.id)}` : null;
  }
  // Routines and other main-site runs open on the main site's run page.
  return run.target.app === "platform" ? `/workflows/${encodeURIComponent(run.workflow)}/runs/${encodeURIComponent(run.run)}` : null;
}

function workflowName(row: ScheduleRow) {
  if (row.source === "routine") return `${row.name ?? words(row.workflowId)}${scopeNote(row.target)}`;
  if (isDiscovery(row.target, row.workflowId)) return `Daily discovery${scopeNote(row.target)}`;
  return `${words(row.workflowId)} (${row.target.app})${scopeNote(row.target)}`;
}

function workflowOf(row: ScheduleRow, userId: string, discovery: Map<string, { id: string }>): Workflow {
  const routine = row.source === "routine";
  const last = row.lastRunId ? { target: row.target, workflow: row.workflowId, run: row.lastRunId } : null;
  return {
    key: routine ? `routine:${row.routine}` : `${row.target.scope}/${row.target.app}/${row.workflowId}`,
    kind: routine ? "routine" : "app",
    target: row.target, workflow: row.workflowId, routine: routine ? (row.routine ?? null) : null,
    name: workflowName(row),
    cadence: row.cadence ?? cadence(row.cron, row.timezone),
    enabled: row.enabled,
    nextRunAt: row.enabled ? row.nextRunAt : null,
    lastRun: last && row.lastRunStatus ? { target: row.target, run: last.run, status: row.lastRunStatus, href: runHref(last, discovery) } : null,
    lastOutcome: row.lastOutcome,
    // A routine says whether the member may change it; an app's schedule runs as the member who saved it.
    canChange: routine ? Boolean(row.canChange) : row.createdBy === userId,
    canDelete: routine && Boolean(row.canChange),
  };
}

function runName(run: RunRow, schedules: ScheduleRow[]) {
  const routine = run.scheduleId ? schedules.find((row) => row.source === "routine" && row.routine === run.scheduleId) : undefined;
  if (routine) return workflowName(routine);
  if (isDiscovery(run.target, run.workflow)) return `Discovery${scopeNote(run.target)}`;
  return `${words(run.workflow)} (${run.target.app})${scopeNote(run.target)}`;
}

/**
 * Everything that runs for the member and their newest runs, from platform Schedules and
 * WorkflowRuns across their personal scope and organizations. Editors only.
 */
export async function workflowsView(host: WorkflowHost<"interactive">, db: Database, who: AppIdentity) {
  requireEditor(who);
  const [schedules, runs] = await Promise.all([
    platform<Page<ScheduleRow>>(host, "Schedules", { first: 100 }),
    platform<Page<RunRow>>(host, "WorkflowRuns", { first: RUN_LIMIT }),
  ]);
  // App control calendars are not workflows; this page lists schedules and routines.
  const rows = schedules.items.filter((row) => row.source === "workflow" || row.source === "routine");
  const discoveryIds = [
    ...runs.items.filter((run) => isDiscovery(run.target, run.workflow)).map((run) => run.run),
    ...rows.filter((row) => isDiscovery(row.target, row.workflowId) && row.lastRunId).map((row) => row.lastRunId as string),
  ];
  const discovery = await discoveryRuns(db, who, [...new Set(discoveryIds)]);
  const workflows = rows.map((row) => workflowOf(row, who.userId, discovery))
    // Forerunner's own daily discovery first, then the rest by name.
    .sort((a, b) => Number(isDiscovery(b.target, b.workflow)) - Number(isDiscovery(a.target, a.workflow)) || a.name.localeCompare(b.name));
  const workflowRuns: WorkflowRun[] = runs.items.map((run) => {
    const record = discovery.get(run.run);
    const running = run.steps.find((step) => step.state === "running")?.id ?? null;
    return {
      target: run.target, run: run.run, name: runName(run, rows), status: run.status,
      stage: run.status === "running" ? (record && record.status !== "complete" && record.status !== "failed" ? record.status : running) : null,
      startedAt: run.createdAt, updatedAt: run.updatedAt, href: runHref(run, discovery),
    };
  });
  return { workflows, workflowRuns };
}

const target = z.strictObject({ scope: z.string().min(1).max(128), app: z.string().min(1).max(128) });
export const scheduleAction = z.strictObject({
  change: z.enum(["run", "pause", "resume", "delete"]),
  target,
  workflow: z.string().min(1).max(64).optional(),
  routine: z.uuid().optional(),
}).refine((input) => Boolean(input.routine) !== Boolean(input.workflow), "Name a routine or an app's workflow");
export const cancelAction = z.strictObject({ target, run: z.uuid() });

/** Runs now, pauses, resumes or deletes one schedule or routine through platform ScheduleChanges. Editors only. */
export async function changeWorkflow(host: WorkflowHost<"interactive">, who: AppIdentity, input: z.infer<typeof scheduleAction>) {
  requireEditor(who);
  const { change: action, ...rest } = input;
  return change(host, "ScheduleChanges", { action, ...rest });
}

/**
 * Cancels a running run through platform WorkflowRunChanges: it settles as failed and no
 * step writes to it again. A discovery run is also marked failed here at once, so it
 * stops at its next stage. Editors only.
 */
export async function cancelRun(host: WorkflowHost<"interactive">, db: Database, who: AppIdentity, input: z.infer<typeof cancelAction>) {
  requireEditor(who);
  const receipt = await change(host, "WorkflowRunChanges", { action: "cancel", ...input });
  if (input.target.app === "forerunner") await cancelDiscoveryRecord(db, who, input.run);
  return receipt;
}

async function cancelDiscoveryRecord(db: Database, who: AppIdentity, runId: string) {
  const record = (await discoveryRuns(db, who, [runId])).get(runId);
  if (!record || record.status === "complete" || record.status === "failed") return;
  const where = and(eq(discoveryRecords.installationId, who.installationId), eq(discoveryRecords.ownerId, who.userId), eq(discoveryRecords.id, record.id));
  const [row] = await db.select().from(discoveryRecords).where(where);
  const run = JSON.parse(row.data) as Record<string, unknown>;
  const at = new Date().toISOString();
  Object.assign(run, { status: "failed", failedWhile: run.status, error: "Canceled.", canceledAt: at, updatedAt: at });
  (run.stages as unknown[] | undefined)?.push({ at, status: "failed" });
  await db.update(discoveryRecords).set({ data: JSON.stringify(run) }).where(where);
}
