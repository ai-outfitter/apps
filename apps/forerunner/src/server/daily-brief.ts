import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { documentWiki } from "@ai-outfitter/app-sdk/wiki-documents";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { scheduleInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import { answerSchema, briefInstructions, digestMarker, evidenceDigest, gatherEvidence, modelData, renderBrief } from "./daily-brief-synthesis";
import { readDayReview } from "./day-review";
import { listItems, type Database } from "./items";
import { localDate, shiftDate } from "./review-period";
import { latestOpenSuggestions, roleSnapshot, saveRoleSnapshot } from "./suggestions";

export const dailyBriefWorkflow = "forerunner-daily-brief";
const timezone = z.string().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid time zone");
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
  return host.call("schedule.save", briefSchedule(input.timezone, input.enabled));
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
  return existing ?? host.call("schedule.save", briefSchedule(timezone.parse(zone), true));
}
export async function dailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity) {
  personal(who);
  return (await host.call("schedules", {})).find(row => row.workflowId === dailyBriefWorkflow) ?? null;
}
export { unavailableBriefSources } from "./daily-brief-synthesis";
export type BriefReceipt = { documentId: string; revision: number; slug: string; date: string; status: "complete" | "incomplete"; outcome: "saved" | "unchanged" | "superseded" };
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
export async function captureDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, input: { date: string; timezone: string; runId: string }, now = Date.now()): Promise<BriefReceipt> {
  personal(who);
  const zone = timezone.parse(input.timezone);
  z.iso.date().parse(input.date);
  if (input.date > localDate(now, zone)) throw new Response("Cannot capture a future brief", { status: 400 });
  const wiki = await documentWiki(host);
  const call = async (query: string, variables: Record<string, unknown>, write = false) => {
    const result = graphGraphqlResult.parse(await host.call("actions.call", { installationId: wiki.installationId, action: write ? "graph.mutate" : "graph.graphql", ...(!write ? { readOnly: true } : {}), input: { query, variables: JSON.parse(JSON.stringify(variables)), maxBytes: 65536 } }));
    if (result.errors?.length || result.extensions?.truncated || !result.data) throw new Error("Daily brief Wiki read/write was incomplete");
    return result.data;
  };
  const slugFor = async (date: string) => `forerunner-brief-${date}-${await stableGraphId(who.owner, who.installationId, zone)}`;
  const read = async (slug: string) => {
    const page = await call("query BriefPage($slug:String!){page(slug:$slug){documentId}}", { slug });
    if (page.page === null) return null;
    const { documentId } = z.object({ documentId: z.string() }).parse(page.page);
    const data = await call("query BriefDraft($id:ID!){document(id:$id){id revision generatedBody archived}}", { id: documentId });
    return z.object({ id: z.string(), revision: z.number(), generatedBody: z.string(), archived: z.boolean() }).parse(data.document);
  };
  const slug = await slugFor(input.date), previousSlug = await slugFor(shiftDate(input.date, -1));
  const [current, prior, review, items, role, discovery] = await Promise.all([
    read(slug), read(previousSlug), readDayReview(db, who, host, { date: shiftDate(input.date, -1), timezone: zone }, now), listItems(db, who),
    roleSnapshot(db, who), latestOpenSuggestions(db, who),
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
  const inputs = { date: input.date, timezone: zone, review, priorities: items.filter(item => item.status !== "done").slice(0, 30), role, discovery, previous, now };
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
    const result = await call("mutation SaveGeneratedDocument($input:SaveGeneratedDocumentInput!){saveGeneratedDocument(input:$input){id revision publishedRevision}}", { input: write }, true);
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
async function runBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, input: { date: string; timezone: string; runId: string }, now: number) {
  await host.call("workflow.start", { workflow: dailyBriefWorkflow, id: input.runId, inputs: {} });
  const collect = (value: Record<string, unknown>) => host.call("workflow.collect", { runId: input.runId, slot: "collect.outputs.brief", value: JSON.parse(JSON.stringify(value)), complete: true });
  try {
    const receipt = await captureDailyBrief(db, who, host, input, now);
    await collect(receipt);
    return receipt;
  } catch (error) {
    const reason = error instanceof BriefGenerationFailed ? error.reason : error instanceof Response ? (await error.clone().text()).slice(0, 300) || "The brief was refused." : "The brief could not be generated. Any earlier brief is unchanged.";
    await collect({ date: input.date, status: "failed", reason }).catch(() => undefined);
    if (error instanceof BriefGenerationFailed) throw new Response(error.reason, { status: error.status });
    throw error;
  }
}
/** The `schedule` phase. The scheduled and manual paths both end in `runBrief`. */
export async function scheduledDailyBrief(db: Database, who: AppIdentity, raw: PhaseInput, host: WorkflowHost<"schedule">, now = Date.now()): Promise<PhaseInput> {
  personal(who);
  const occurrence = scheduleInput.parse(raw);
  if (occurrence.schedule.workflowId !== dailyBriefWorkflow) return { outcome: "declined", reason: "Not a daily brief schedule" };
  const saved = (await host.call("schedules", {})).find(row => row.id === occurrence.schedule.id);
  if (!saved) return { outcome: "declined", reason: "Daily brief schedule no longer exists" };
  // The occurrence's own date, not the retry's. A failure is recorded on the run; the schedule itself started.
  await runBrief(db, who, host as unknown as WorkflowHost<"interactive">, { date: localDate(occurrence.scheduledFor, saved.timezone), timezone: saved.timezone, runId: occurrence.runId }, now)
    .catch(error => { if (!(error instanceof Response)) throw error; });
  return { outcome: "started" };
}
export const generateDailyBriefInput = z.strictObject({ timezone: timezone });
export async function generateDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, raw: z.input<typeof generateDailyBriefInput>, now = Date.now()) {
  personal(who);
  const input = generateDailyBriefInput.parse(raw), runId = crypto.randomUUID();
  // The member asked for this run, so their current role can be saved for it and for later unattended runs.
  await saveRoleSnapshot(db, who, host).catch(() => undefined);
  const receipt = await runBrief(db, who, host, { date: localDate(now, input.timezone), timezone: input.timezone, runId }, now);
  return { ...receipt, runId };
}
