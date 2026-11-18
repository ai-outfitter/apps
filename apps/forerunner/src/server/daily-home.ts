import { wikiDocuments, wikiPackage } from "@ai-outfitter/app-sdk/wiki-documents";
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
 * The owner's saved briefs for `date`, read with one Wiki request: today's and
 * yesterday's pages with their documents. `current` is today's brief.
 * `previous` is yesterday's reference (its body only when `previousBody`).
 * `latest` is the newest earlier brief with its body, so a page can show the
 * last dated snapshot without calling it today's; only when neither today nor
 * yesterday has one does a second request look further back.
 */
export async function savedBriefs(host: Host, owner: AppIdentity, date: string, zone: string, options: { previousBody?: boolean; timings?: Timings } = {}) {
  const timings = options.timings ?? {};
  const dates = Array.from({ length: lookbackDays }, (_, index) => shiftDate(date, -index));
  const slugs = await Promise.all(dates.map(day => briefSlug(owner, day, zone)));
  const read = async (from: number, to: number) => {
    const days = dates.slice(from, to).map((_, offset) => from + offset);
    const pages = await timed(timings, "briefRead", () => wikiDocuments(host, "graph.graphql",
      `query DailyHomeBriefs(${days.map(index => `$s${index}:String!`).join(",")}){${days.map(index => `d${index}:page(slug:$s${index}){document{id revision generatedBody provenance archived createdAt}}`).join(" ")}}`,
      Object.fromEntries(days.map(index => [`s${index}`, slugs[index]]))));
    return days.map(index => {
      const doc = z.object({ document: briefDocument.nullable() }).nullable().parse(pages[`d${index}`] ?? null)?.document;
      if (!doc) return null;
      if (doc.archived) return "archived" as const;
      if (!briefProvenance.safeParse(JSON.parse(doc.provenance || "null")).success) throw new Error("Saved page is not a Forerunner daily brief");
      return { documentId: doc.id, revision: doc.revision, slug: slugs[index], href: `/apps/${wikiPackage}/p/${encodeURIComponent(slugs[index])}?revision=${doc.revision}`,
        markdown: doc.generatedBody ?? "", status: "incomplete" as const, date: dates[index], timezone: zone, savedAt: doc.createdAt ?? null };
    });
  };
  const shown = <T>(brief: T | "archived" | null) => brief === "archived" ? null : brief;
  const [today, prior] = await read(0, 2);
  const current = shown(today), yesterday = shown(prior);
  // An archived brief for today is not replaced by an older day's.
  const latest = today ? null : yesterday ?? shown((prior ? [] : await read(2, lookbackDays)).find(brief => brief !== null) ?? null);
  return { current, previous: yesterday && !options.previousBody ? { ...yesterday, markdown: "" } : yesterday, latest };
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
  // The board does not wait on the time zone: it is read while the schedule loads.
  const started = <T>(work: Promise<T>) => { work.catch(() => undefined); return work; };
  const board = sections.has("priorities") ? started(timed(timings, "priorities", () => listItems(db, identity))) : null;
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
    board,
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
