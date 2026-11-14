import { documentWiki } from "@ai-outfitter/app-sdk/wiki-documents";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { dailyBriefSchedule } from "./daily-brief";
import { readDayReview } from "./day-review";
import { listItems, type Database } from "./items";
import { localDate, shiftDate } from "./review-period";

const timezone = z.string().min(1).max(64).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
/** What a homepage can read on its own: the saved digest, board priorities, yesterday's reports, last week's. */
export const dailyHomeSections = ["digest", "priorities", "review", "history"] as const;
export type DailyHomeSection = (typeof dailyHomeSections)[number];
export const dailyHomeInput = z.strictObject({
  timezone: timezone.optional(), includeHistory: z.boolean().default(false),
  /** Read only these sections. Omitted: the digest, priorities and yesterday (with includeHistory, last week too) in one answer. */
  sections: z.array(z.enum(dailyHomeSections)).min(1).max(dailyHomeSections.length).optional(),
});
type Host = WorkflowHost<"interactive">;
const briefDocument = z.object({ id: z.string(), revision: z.number().int().positive(), generatedBody: z.string().optional(), provenance: z.string().nullable().optional(), archived: z.boolean(), createdAt: z.string().nullable().optional() });
// Wiki deliberately exposes only the provenance kind to readers. The dated,
// owner-scoped page slug pins the period; the current brief workflow always
// records incomplete coverage while provider adapters remain unavailable.
const briefProvenance = z.object({ kind: z.literal("forerunner.daily-brief") });
/** Today and the six days before it: how far back a missing brief looks for the last saved one. */
const lookbackDays = 7;

export function dailyHomeDates(now: number, zone: string) {
  const date = localDate(now, zone), yesterday = shiftDate(date, -1);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekEnd = shiftDate(date, -(weekday || 7)), weekStart = shiftDate(weekEnd, -6);
  return { date, yesterday, weekStart, weekEnd, weekDates: Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index)) };
}

export const briefSlug = async (owner: AppIdentity, date: string, zone: string) =>
  `forerunner-brief-${date}-${await stableGraphId(owner.owner, owner.installationId, zone)}`;

type Timings = Record<string, number>;
const timed = async <T>(timings: Timings, name: string, work: () => Promise<T>) => {
  const started = Date.now();
  try { return await work(); } finally { timings[name] = (timings[name] ?? 0) + Date.now() - started; }
};

/**
 * The owner's saved briefs for `date`, read with one Wiki provider resolution
 * and two Wiki requests: one page lookup for today and the days before it,
 * then one document read. `current` is today's brief. `previous` is
 * yesterday's reference (its body only when `previousBody`). `latest` is the
 * newest earlier brief with its body, read only when today's is missing, so a
 * page can show the last dated snapshot without calling it today's.
 */
export async function savedBriefs(host: Host, owner: AppIdentity, date: string, zone: string, options: { previousBody?: boolean; timings?: Timings } = {}) {
  const timings = options.timings ?? {};
  const wiki = await timed(timings, "wikiProvider", () => documentWiki(host));
  const query = async (query: string, variables: Record<string, unknown>) => {
    const result = graphGraphqlResult.parse(await host.call("actions.call", {
      installationId: wiki.installationId, action: "graph.graphql", readOnly: true,
      input: { query, variables: JSON.parse(JSON.stringify(variables)), maxBytes: 131072 },
    }));
    if (result.errors?.length || result.extensions?.truncated || !result.data) throw new Error("Saved daily brief could not be read");
    return result.data;
  };
  const dates = Array.from({ length: lookbackDays }, (_, index) => shiftDate(date, -index));
  const slugs = await Promise.all(dates.map(day => briefSlug(owner, day, zone)));
  const pages = await timed(timings, "briefLookup", () => query(
    `query DailyHomePages(${dates.map((_, index) => `$s${index}:String!`).join(",")}){${dates.map((_, index) => `d${index}:page(slug:$s${index}){documentId}`).join(" ")}}`,
    Object.fromEntries(slugs.map((slug, index) => [`s${index}`, slug]))));
  const ids = dates.map((_, index) => z.object({ documentId: z.string() }).nullable().parse(pages[`d${index}`] ?? null)?.documentId ?? null);
  // Today's body, or else the newest earlier brief's. Yesterday is also read as a reference when it is neither.
  const bodyIndex = ids.findIndex(id => id !== null);
  const wanted = [...new Set([bodyIndex, ids[1] ? 1 : -1].filter(index => index >= 0))];
  if (!wanted.length) return { current: null, previous: null, latest: null };
  const full = (index: number) => index === bodyIndex || (index === 1 && options.previousBody === true);
  const documents = await timed(timings, "briefRead", () => query(
    `query DailyHomeDocuments(${wanted.map(index => `$i${index}:ID!`).join(",")}){${wanted.map(index => `b${index}:document(id:$i${index}){id revision ${full(index) ? "generatedBody " : ""}provenance archived createdAt}`).join(" ")}}`,
    Object.fromEntries(wanted.map(index => [`i${index}`, ids[index]]))));
  const brief = (index: number) => {
    if (!wanted.includes(index)) return null;
    const doc = briefDocument.parse(documents[`b${index}`]);
    if (doc.archived) return null;
    if (!briefProvenance.safeParse(JSON.parse(doc.provenance || "null")).success) throw new Error("Saved page is not a Forerunner daily brief");
    const slug = slugs[index];
    return { documentId: doc.id, revision: doc.revision, slug, href: `/apps/wiki-map/p/${encodeURIComponent(slug)}?revision=${doc.revision}`,
      markdown: doc.generatedBody ?? "", status: "incomplete" as const, date: dates[index], timezone: zone, savedAt: doc.createdAt ?? null };
  };
  const current = brief(0), previous = brief(1);
  return { current, previous, latest: current || bodyIndex <= 0 ? null : brief(bodyIndex) };
}

/** The saved brief for one date, or null when none is saved or it is archived. */
export async function savedBrief(host: Host, owner: AppIdentity, date: string, zone: string) {
  return (await savedBriefs(host, owner, date, zone)).current;
}

/**
 * A homepage snapshot from saved, authorized records. It never starts
 * generation, a workflow, a connector read or a schedule write. With
 * `sections`, only those sections are read, so a page can render the saved
 * digest without waiting on cross-organization reports; each answer carries
 * `timings` (milliseconds only, no content or identifiers).
 */
export async function readDailyHome(db: Database, identity: AppIdentity, host: Host, raw: z.input<typeof dailyHomeInput>, now = Date.now()) {
  requireEditor(identity);
  if (identity.owner.kind !== "user" || identity.owner.id !== identity.userId) throw new Response("Daily home requires your personal installation", { status: 403 });
  const input = dailyHomeInput.parse(raw);
  const combined = !input.sections;
  const sections = new Set<DailyHomeSection>(input.sections ?? ["digest", "priorities", "review", ...(input.includeHistory ? ["history" as const] : [])]);
  const timings: Timings = {};
  // The schedule names the member's time zone; a caller that already knows it skips the read outside the digest.
  const schedule = sections.has("digest") || !input.timezone ? await timed(timings, "schedule", () => dailyBriefSchedule(host, identity)) : undefined;
  const zone = timezone.parse(input.timezone ?? schedule?.timezone ?? "UTC");
  const { date, yesterday, weekStart, weekEnd, weekDates } = dailyHomeDates(now, zone);
  const warnings: string[] = [];
  const digest = async () => {
    try { return { ...await savedBriefs(host, identity, date, zone, { previousBody: combined, timings }), briefState: "read" as const }; }
    catch {
      warnings.push(`The saved daily brief for ${date} could not be read.`);
      return { current: null, previous: null, latest: null, briefState: "unavailable" as const };
    }
  };
  const [briefs, priorities, priorDay, weekDays] = await Promise.all([
    sections.has("digest") ? digest() : null,
    sections.has("priorities") ? timed(timings, "priorities", () => listItems(db, identity)) : null,
    sections.has("review") ? timed(timings, "review", () => readDayReview(db, identity, host, { date: yesterday, timezone: zone }, now)) : null,
    sections.has("history") ? timed(timings, "history", () => Promise.all(weekDates.map(day => readDayReview(db, identity, host, { date: day, timezone: zone }, now)))) : null,
  ]);
  if (briefs) {
    if (!schedule) warnings.push("The personal daily brief schedule has not been set up.");
    if (briefs.briefState === "read" && !briefs.current) warnings.push(`No saved daily brief is available for ${date}.`);
  }
  return {
    date, timezone: zone, sections: [...sections], timings, warnings,
    ...(briefs ? {
      scheduleSetupRequired: !schedule, schedule: schedule ?? null, brief: briefs.current, previousBrief: briefs.previous,
      // Today's brief is saved, missing, or could not be read. A missing one may still show the last dated snapshot.
      briefState: briefs.briefState === "unavailable" ? "unavailable" as const : briefs.current ? "saved" as const : "missing" as const,
      latestBrief: briefs.latest,
    } : {}),
    ...(priorities ? { priorities: priorities.filter(item => item.status !== "done").slice(0, 30).map(item => ({ id: item.id, title: item.title, category: item.category, status: item.status, dueDate: item.dueDate })) } : {}),
    ...(priorDay ? { yesterday: priorDay } : {}),
    ...(weekDays || combined ? { previousWeek: { startDate: weekStart, endDate: weekEnd, days: weekDays ?? [] }, historyIncluded: weekDays !== null } : {}),
  };
}
