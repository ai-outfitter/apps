import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { documentWiki } from "@ai-outfitter/app-sdk/wiki-documents";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { scheduleInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import { readDayReview, type DayReview } from "./day-review";
import { listItems, type Database } from "./items";
import { localDate, shiftDate } from "./review-period";

export const dailyBriefWorkflow = "forerunner-daily-brief";
const timezone = z.string().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid time zone");
export const dailyBriefScheduleInput = z.strictObject({ enabled: z.boolean(), timezone: timezone });
function personal(who: AppIdentity) {
  requireEditor(who);
  if (who.owner.kind !== "user" || who.owner.id !== who.userId) throw new Response("Daily brief requires your personal installation", { status: 403 });
}
export async function setDailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity, raw: z.input<typeof dailyBriefScheduleInput>) {
  personal(who);
  const input = dailyBriefScheduleInput.parse(raw);
  return host.call("schedule.save", { workflow: dailyBriefWorkflow, cron: "0 5 * * *", timezone: input.timezone, enabled: input.enabled, inputs: {} });
}
export async function dailyBriefSchedule(host: WorkflowHost<"interactive">, who: AppIdentity) {
  personal(who);
  return (await host.call("schedules", {})).find(row => row.workflowId === dailyBriefWorkflow) ?? null;
}
export const unavailableBriefSources = ["Google Analytics", "PostHog", "Stripe", "Databricks", "personal calendar and mail"];
type Priority = { title: string; category: string };
/** Deterministic synthesis; no inferred completion, model claims, or provider measurements. */
export function briefMarkdown(date: string, review: DayReview, priorities: Priority[], previous: { slug: string; revision: number } | null) {
  const sections = [`# Today — ${date}`, `Based on the completed day ${review.period.date} (${review.period.timezone}).`, "## Your priorities", ...priorities.map(item => `- ${item.title}`), "## Across your projects"];
  for (const org of review.organizations) {
    sections.push(`### ${org.name}`, org.summary || "No summary available.");
    for (const project of org.projects ?? []) sections.push(`- **${project.name}**: ${project.update || "No project update available."}`);
    if (org.href) sections.push(`[Saved report revision](${org.href})`);
    if (org.status !== "complete") sections.push(`Coverage: ${org.status}.`);
  }
  if (review.overview) sections.push("## Personal planning", review.overview.summary, ...(review.overview.href ? [`[Saved overview revision](${review.overview.href})`] : []));
  sections.push("## Completed yesterday", ...review.completions.map(item => `- ${item.title}`));
  if (!review.completions.length) sections.push("No board completions were recorded for this day.");
  sections.push("## Carry forward", previous ? `[Previous daily brief](./${previous.slug}?revision=${previous.revision}). Open priorities above reflect their current state; previous notes are context, not new completion evidence.` : "No previous daily brief is available; this is the start of the saved series.");
  sections.push("## Source coverage", ...review.warnings.map(warning => `- ${warning}`), ...unavailableBriefSources.map(name => `- ${name}: not collected; adapter not connected to this job. No measurements inferred.`));
  return sections.join("\n\n");
}
export async function captureDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, input: { date: string; timezone: string; runId: string }, now = Date.now()) {
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
  const [current, prior, review, items] = await Promise.all([
    read(slug), read(previousSlug), readDayReview(db, who, host, { date: shiftDate(input.date, -1), timezone: zone }, now), listItems(db, who),
  ]);
  if (current?.archived) throw new Response("This daily brief is archived", { status: 409 });
  // A rerun of a past date never combines today's priorities with a historical brief.
  if (input.date < localDate(now, zone)) {
    if (!current) throw new Response("Historical backfill needs historical priority snapshots", { status: 409 });
    return { documentId: current.id, revision: current.revision, slug, date: input.date, status: "incomplete" as const };
  }
  const priorities = items.filter(item => item.status !== "done").slice(0, 30);
  const generatedBody = briefMarkdown(input.date, review, priorities, prior && !prior.archived ? { slug: previousSlug, revision: prior.revision } : null);
  // Provider adapters are deliberately missing; report receipt must remain incomplete.
  const status = "incomplete" as const;
  if (current?.generatedBody === generatedBody) return { documentId: current.id, revision: current.revision, slug, date: input.date, status };
  const write = { ...(current ? { id: current.id, revision: current.revision } : { slug, title: `Daily brief — ${input.date}` }), generatedBody,
    provenance: { kind: "forerunner.daily-brief", owner: who.owner, installationId: who.installationId, date: input.date, timezone: zone, runId: input.runId, capturedAt: now, status, previous: prior && !prior.archived ? { documentId: prior.id, revision: prior.revision } : null } };
  if (new TextEncoder().encode(JSON.stringify(write)).byteLength > 32768) throw new Error("Daily brief exceeds the write limit; no document changed");
  const saved = await call("mutation SaveGeneratedDocument($input:SaveGeneratedDocumentInput!){saveGeneratedDocument(input:$input){id revision publishedRevision}}", { input: write }, true);
  const receipt = z.object({ saveGeneratedDocument: z.object({ id: z.string(), revision: z.number() }) }).parse(saved).saveGeneratedDocument;
  return { documentId: receipt.id, revision: receipt.revision, slug, date: input.date, status };
}
export async function scheduledDailyBrief(db: Database, who: AppIdentity, raw: PhaseInput, host: WorkflowHost<"schedule">): Promise<PhaseInput> {
  personal(who);
  const occurrence = scheduleInput.parse(raw);
  if (occurrence.schedule.workflowId !== dailyBriefWorkflow) return { outcome: "declined", reason: "Not a daily brief schedule" };
  const saved = (await host.call("schedules", {})).find(row => row.id === occurrence.schedule.id);
  if (!saved) return { outcome: "declined", reason: "Daily brief schedule no longer exists" };
  await host.call("workflow.start", { workflow: dailyBriefWorkflow, id: occurrence.runId, inputs: {} });
  const receipt = await captureDailyBrief(db, who, host as unknown as WorkflowHost<"interactive">, { date: localDate(occurrence.scheduledFor, saved.timezone), timezone: saved.timezone, runId: occurrence.runId });
  await host.call("workflow.collect", { runId: occurrence.runId, slot: "collect.outputs.brief", value: receipt, complete: true });
  return { outcome: "started" };
}
export const generateDailyBriefInput = z.strictObject({ timezone: timezone });
export async function generateDailyBrief(db: Database, who: AppIdentity, host: WorkflowHost<"interactive">, raw: z.input<typeof generateDailyBriefInput>) {
  personal(who);
  const input = generateDailyBriefInput.parse(raw), runId = crypto.randomUUID();
  const receipt = await captureDailyBrief(db, who, host, { date: localDate(Date.now(), input.timezone), timezone: input.timezone, runId });
  await host.call("workflow.start", { workflow: dailyBriefWorkflow, id: runId, inputs: {} });
  await host.call("workflow.collect", { runId, slot: "collect.outputs.brief", value: receipt, complete: true });
  return { ...receipt, runId };
}
