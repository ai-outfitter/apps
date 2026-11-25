import { reportTimezone } from "@ai-outfitter/app-sdk/daily-period";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { readWikiPage, wikiDocuments } from "@ai-outfitter/app-sdk/wiki-documents";
import { scheduleInput, type InstallationSchedule, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { answerSchema, briefInstructions, digestMarker, evidenceDigest, gatherEvidence, modelData, renderBrief } from "./daily-brief-synthesis";
import { currentMemberships, readDayReview } from "./day-review";
import { listItems, type Database } from "./items";
import { readAppUpdates, readWikiActivity, type AppUpdates } from "./app-updates";
import { briefSlug, briefTimezone as timezone } from "./brief-config";
import { briefDependencies, type DiscoveryReceipt } from "./brief-dependencies";
import { readPlanningWork } from "./planning-work";
import { localDate, reviewPeriod, shiftDate } from "./review-period";
import { latestOpenSuggestions, roleSnapshot, saveRoleSnapshot } from "./suggestions";

export const dailyBriefWorkflow = "forerunner-daily-brief";
export const dailyBriefScheduleInput = z.strictObject({
  enabled: z.boolean(), timezone: timezone,
  /** Save only when no daily brief schedule exists at all. A saved one, enabled, disabled or customized, is returned untouched. */
  ifUnset: z.boolean().optional(),
}).refine(input => !input.ifUnset || input.enabled, "ifUnset only turns the default schedule on");
function personal(who: AppIdentity) {
  requireEditor(who);
  if (who.owner.kind !== "user" || who.owner.id !== who.userId) throw new Response("Daily brief requires your personal installation", { status: 403 });
}
const briefSchedule = (timezone: string, enabled: boolean) => ({ workflow: dailyBriefWorkflow, cron: "0 5 * * *", timezone, enabled, inputs: {} });
export async function setDailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity, raw: z.input<typeof dailyBriefScheduleInput>) {
  personal(who);
  const input = dailyBriefScheduleInput.parse(raw);
  if (input.ifUnset) return defaultDailyBriefSchedule(host, who, input.timezone);
  const existing = await dailyBriefSchedule(host, who);
  const next = briefSchedule(input.timezone, input.enabled);
  return host.call("schedule.save", existing ? { ...next, cron: existing.cron, inputs: existing.inputs } : next);
}
/**
 * The daily brief is on by default for a personal installation. With no saved
 * forerunner-daily-brief schedule at all, this saves the standard 05:00 one in
 * `zone`, the time zone the member's own device reported on this request. Any
 * saved schedule is the member's choice and is returned as it is: one they
 * turned off stays off, and a custom time or time zone is kept. It attaches no
 * connection and touches no other workflow's schedule. Returns null for an
 * installation that is not the caller's own personal one.
 */
export async function defaultDailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity, zone: string) {
  if (!who.canEdit || who.owner.kind !== "user" || who.owner.id !== who.userId) return null;
  const existing = (await host.call("schedules", {})).find(row => row.workflowId === dailyBriefWorkflow);
  return existing ?? saveDefaultBriefSchedule(host, zone);
}
export function saveDefaultBriefSchedule(host: WorkflowHost<"interactive">, zone: string) {
  return host.call("schedule.save", { ...briefSchedule(timezone.parse(zone), true), ifUnset: true });
}
export async function dailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity) {
  personal(who);
  return (await host.call("schedules", {})).find(row => row.workflowId === dailyBriefWorkflow) ?? null;
}
export { unavailableBriefSources } from "./daily-brief-synthesis";
const savedReceipt = z.object({
  documentId: z.string(), revision: z.number().int().positive(), slug: z.string(), date: z.iso.date(),
  status: z.enum(["complete", "incomplete"]), outcome: z.enum(["saved", "unchanged", "superseded"]),
});
export const briefSlotReceipt = z.union([savedReceipt, z.object({
  date: z.iso.date(), status: z.literal("failed"), reason: z.string().max(300).optional(),
})]);
export type BriefReceipt = z.infer<typeof savedReceipt>;
type CaptureInput = { date: string; timezone: string; runId: string; dependencies?: {
  gaps: string[]; receipts: DiscoveryReceipt[]; updates: AppUpdates;
} };
/** A run that wrote nothing: the reason is safe to show, and any earlier saved revision is untouched. */
export class BriefGenerationFailed extends Error {
  constructor(public reason: string, public status = 502) { super(reason); }
}
const conflict = (error: unknown) => error instanceof Response && error.status === 409;

/**
 * Writes the dated digest for `input.date` into the owner's Wiki from saved,
 * authorized evidence, as one model answer inside the run `input.runId`.
 *
 * - An archived document is refused, and a past date is never rewritten.
 * - Evidence unchanged since the saved revision reuses that revision: no model
 *   call and no write, so retries and repeated runs are idempotent.
 * - A model failure, an answer citing anything outside the evidence, or a
 *   failed Wiki write throws `BriefGenerationFailed` and changes nothing.
 * - The write carries the revision read at the start. If another run saved
 *   first, that newer revision stands and is returned as `superseded`.
 */
export async function captureDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, input: CaptureInput, now = Date.now()): Promise<BriefReceipt> {
  personal(who);
  const zone = timezone.parse(input.timezone);
  z.iso.date().parse(input.date);
  if (input.date > localDate(now, zone)) throw new Response("Cannot capture a future brief", { status: 400 });
  const slugFor = (date: string) => briefSlug(who, date, zone);
  const read = (slug: string) => readWikiPage(host, slug);
  const slug = await slugFor(input.date), previousSlug = await slugFor(shiftDate(input.date, -1));
  const [current, prior, review, items, role, discovery, work, appUpdates, wikiActivity] = await Promise.all([
    read(slug), read(previousSlug), readDayReview(db, who, host, { date: shiftDate(input.date, -1), timezone: zone }, now), listItems(db, who),
    roleSnapshot(db, who), latestOpenSuggestions(db, who), readPlanningWork(host), input.dependencies?.updates ?? readAppUpdates(host, shiftDate(input.date, -1)), readWikiActivity(host, reviewPeriod({ date: shiftDate(input.date, -1), timezone: zone }, now)),
  ]);
  if (current?.archived) throw new Response("This daily brief is archived", { status: 409 });
  // Missing provider adapters keep every receipt incomplete; unknown is not zero.
  const status = "incomplete" as const;
  const saved = (doc: { id: string; revision: number }, outcome: BriefReceipt["outcome"]): BriefReceipt => ({ documentId: doc.id, revision: doc.revision, slug, date: input.date, status, outcome });
  // A rerun of a past date never combines today's priorities with a historical brief.
  if (input.date < localDate(now, zone)) {
    if (!current) throw new Response("Historical backfill needs historical priority snapshots", { status: 409 });
    return saved(current, "unchanged");
  }
  const previous = prior && !prior.archived ? { slug: previousSlug, revision: prior.revision } : null;
  const inputs = { date: input.date, timezone: zone, review, priorities: items.filter(item => item.status !== "done").slice(0, 30), work, appUpdates, wikiActivity,
    dependencyGaps: input.dependencies?.gaps, discoveryReceipts: input.dependencies?.receipts, role, discovery, previous, now };
  const { evidence, gaps } = gatherEvidence(inputs);
  const digest = await evidenceDigest(inputs, evidence, gaps);
  if (current?.generatedBody.includes(digestMarker(digest))) return saved(current, "unchanged");
  if (!evidence.length) throw new BriefGenerationFailed("No saved evidence was available to write a brief from. Nothing was saved.", 409);
  const schema = answerSchema(evidence);
  let generatedBody: string;
  try {
    const response = await host.call("inference.generate", { runId: input.runId, step: "collect", checkpointId: `brief.${digest}`, instructions: briefInstructions, data: modelData(inputs, evidence, gaps), schema: z.record(z.string(), z.json()).parse(z.toJSONSchema(schema)) });
    generatedBody = renderBrief(inputs, evidence, gaps, schema.parse(response.output), digest);
  } catch (error) {
    if (error instanceof z.ZodError) throw new BriefGenerationFailed("The model's answer cited sources outside the saved evidence or did not match the brief format. Nothing was saved.", 422);
    throw new BriefGenerationFailed("The brief could not be written by the model. Nothing was saved; any earlier brief is unchanged.");
  }
  const write = { ...(current ? { id: current.id, revision: current.revision } : { slug, title: `Daily brief — ${input.date}` }), generatedBody,
    provenance: { kind: "forerunner.daily-brief", generation: "model-synthesis", owner: who.owner, installationId: who.installationId, date: input.date, timezone: zone, runId: input.runId, capturedAt: now, status, evidenceDigest: digest,
      sources: evidence.map(row => ({ ref: row.ref, kind: row.kind, ...(row.scope ? { scope: row.scope } : {}), ...(row.recordId ? { recordId: row.recordId } : {}), ...(row.revision ? { revision: row.revision } : {}), ...(row.href ? { href: row.href } : {}) })),
      gaps: gaps.length, previous: prior && !prior.archived ? { documentId: prior.id, revision: prior.revision } : null } };
  if (new TextEncoder().encode(JSON.stringify(write)).byteLength > 32768) throw new BriefGenerationFailed("The brief exceeds the Wiki write limit. Nothing was saved.", 413);
  try {
    const result = await wikiDocuments(host, "graph.mutate", "mutation SaveGeneratedDocument($input:SaveGeneratedDocumentInput!){saveGeneratedDocument(input:$input){id revision publishedRevision}}", { input: write }, 65536);
    return saved(z.object({ saveGeneratedDocument: z.object({ id: z.string(), revision: z.number() }) }).parse(result).saveGeneratedDocument, "saved");
  } catch (error) {
    // Another run for the same day may have saved first. Its revision stands; this one writes nothing over it.
    const latest = await read(slug).catch(() => null);
    if (latest && !latest.archived && (!current || latest.revision > current.revision)) return saved(latest, "superseded");
    if (conflict(error)) throw error;
    throw new BriefGenerationFailed("The brief could not be saved to your Wiki. Any earlier brief is unchanged.");
  }
}
/** One run: start it, write the brief, and settle its output either way so the run records what happened. */
async function runBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, input: CaptureInput, now: number) {
  const existing = (await host.call("workflow.read", { id: input.runId }).catch(() => null))?.outputs["collect.outputs.brief"];
  if (existing?.complete) {
    const receipt = briefSlotReceipt.safeParse(existing.value).data;
    if (receipt?.date === input.date) {
      if (receipt.status === "failed") throw new Response(receipt.reason ?? "The previous attempt failed.", { status: 502 });
      return receipt;
    }
  }
  await host.call("workflow.start", { workflow: dailyBriefWorkflow, id: input.runId, inputs: {} });
  const collect = (value: Record<string, unknown>) => host.call("workflow.collect", { runId: input.runId, slot: "collect.outputs.brief", value: JSON.parse(JSON.stringify(value)), complete: true });
  let receipt: BriefReceipt;
  try {
    receipt = await captureDailyBrief(db, who, host, input, now);
  } catch (error) {
    const reason = error instanceof BriefGenerationFailed ? error.reason : error instanceof Response ? (await error.clone().text()).slice(0, 300) || "The brief was refused." : "The brief could not be generated. Any earlier brief is unchanged.";
    await collect({ date: input.date, status: "failed", reason }).catch(cause => { throw new Error("Could not record the brief failure", { cause }); });
    if (error instanceof BriefGenerationFailed) throw new Response(error.reason, { status: error.status });
    throw error;
  }
  await collect(receipt).catch(cause => { throw new Error("Could not record the saved brief", { cause }); });
  return receipt;
}
/** The `schedule` phase. The scheduled and manual paths both end in `runBrief`. */
export async function scheduledDailyBrief(db: Database, who: AppIdentity, raw: PhaseInput, host: WorkflowHost<"schedule">, now = Date.now()): Promise<PhaseInput> {
  personal(who);
  const occurrence = scheduleInput.parse(raw);
  if (occurrence.schedule.workflowId !== dailyBriefWorkflow) return { outcome: "declined", reason: "Not a daily brief schedule" };
  const schedules = await host.call("schedules", {});
  const saved = schedules.find(row => row.id === occurrence.schedule.id);
  if (!saved) return { outcome: "declined", reason: "Daily brief schedule no longer exists" };
  if (!saved.enabled && occurrence.trigger === "clock") return { outcome: "declined", reason: "Daily brief schedule is disabled" };
  const clock = occurrence.trigger === "clock";
  const slot = clock ? saved.pendingFor ?? occurrence.scheduledFor : occurrence.scheduledFor;
  const date = localDate(slot, saved.timezone);
  const deadline = slot + 3 * 3_600_000;
  const interactive = host as unknown as WorkflowHost<"interactive">;
  const dependencies = await readBriefDependencies(interactive, schedules, date, saved.timezone, now, deadline);
  if (clock && dependencies.waiting && now < deadline) {
    return { outcome: "deferred", retryAt: Math.min(deadline, now + 5 * 60_000), reason: "Waiting for this morning's discovery and the previous day's Onto activity." };
  }
  // The occurrence's own date, not the retry's. A failure is recorded on the run; the schedule itself started.
  await runBrief(db, who, interactive, { date, timezone: saved.timezone, runId: occurrence.runId, dependencies }, now)
    .catch(error => { if (!(error instanceof Response)) throw error; });
  return { outcome: "started" };
}
async function readBriefDependencies(host: WorkflowHost<"interactive">, schedules: InstallationSchedule[], date: string, timezone: string, now: number, deadline?: number) {
  const [discovery, updates, memberships] = await Promise.all([
    briefDependencies(host, schedules, date, timezone, now, deadline),
    readAppUpdates(host, shiftDate(date, -1)),
    currentMemberships(host).catch(() => null),
  ]);
  const ontoScopes = new Set(updates.rows.filter(row => row.app === "Onto").map(row => row.scope));
  const expected = ["personal", ...(memberships ?? []).filter(org => org.appSlugs.includes("onto")).map(org => org.slug)];
  const missing = expected.filter(scope => !ontoScopes.has(scope));
  const gaps = [...discovery.gaps, ...missing.map(scope => `Onto (${scope}): no saved activity report for the previous day in this reporting time zone. Coverage is unknown.`)];
  if (!memberships) gaps.push("Onto: organization access could not be checked.");
  const ontoWaiting = !ontoScopes.has("personal") && updates.complete && deadline !== undefined && defaultOntoDueBy(date, deadline);
  return { ...discovery, updates, gaps, waiting: discovery.waiting || ontoWaiting };
}

// The default Onto producer runs at 02:00 in its reporting zone. Compare
// wall time so DST does not shift the deadline to a different local hour.
function defaultOntoDueBy(date: string, deadline: number) {
  const producerDay = localDate(deadline, reportTimezone);
  if (producerDay !== date) return producerDay > date;
  const hour = new Intl.DateTimeFormat("en", { timeZone: reportTimezone, hour: "2-digit", hourCycle: "h23" }).format(deadline);
  return Number(hour) >= 2;
}

export const generateDailyBriefInput = z.strictObject({ timezone: timezone });
export async function generateDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, raw: z.input<typeof generateDailyBriefInput>, now = Date.now()) {
  personal(who);
  const input = generateDailyBriefInput.parse(raw), runId = crypto.randomUUID();
  // The member asked for this run, so their current role can be saved for it and for later unattended runs.
  const date = localDate(now, input.timezone);
  const schedules = await host.call("schedules", {}).catch(() => null);
  const [dependencies] = await Promise.all([
    schedules ? readBriefDependencies(host, schedules, date, input.timezone, now) : undefined,
    saveRoleSnapshot(db, who, host).catch(() => undefined),
  ]);
  const receipt = await runBrief(db, who, host, { date, timezone: input.timezone, runId, dependencies }, now);
  return { ...receipt, runId };
}
