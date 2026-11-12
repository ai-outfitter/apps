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
export const dailyHomeInput = z.strictObject({ timezone: timezone.optional(), includeHistory: z.boolean().default(false) });
type Host = WorkflowHost<"interactive">;
const briefDocument = z.object({ id: z.string(), revision: z.number().int().positive(), generatedBody: z.string(), provenance: z.string().nullable().optional(), archived: z.boolean() });
// Wiki deliberately exposes only the provenance kind to readers. The dated,
// owner-scoped page slug pins the period; the current brief workflow always
// records incomplete coverage while provider adapters remain unavailable.
const briefProvenance = z.object({ kind: z.literal("forerunner.daily-brief") });

export function dailyHomeDates(now: number, zone: string) {
  const date = localDate(now, zone), yesterday = shiftDate(date, -1);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekEnd = shiftDate(date, -(weekday || 7)), weekStart = shiftDate(weekEnd, -6);
  return { date, yesterday, weekStart, weekEnd, weekDates: Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index)) };
}

export async function savedBrief(host: Host, owner: AppIdentity, date: string, zone: string) {
  const wiki = await documentWiki(host);
  const slug = `forerunner-brief-${date}-${await stableGraphId(owner.owner, owner.installationId, zone)}`;
  const query = async (query: string, variables: Record<string, unknown>) => {
    const result = graphGraphqlResult.parse(await host.call("actions.call", {
      installationId: wiki.installationId, action: "graph.graphql", readOnly: true,
      input: { query, variables: JSON.parse(JSON.stringify(variables)), maxBytes: 65536 },
    }));
    if (result.errors?.length || result.extensions?.truncated || !result.data) throw new Error("Saved daily brief could not be read");
    return result.data;
  };
  const page = await query("query DailyHomePage($slug:String!){page(slug:$slug){documentId}}", { slug });
  if (page.page == null) return null;
  const id = z.object({ documentId: z.string() }).parse(page.page).documentId;
  const result = await query("query DailyHomeDocument($id:ID!){document(id:$id){id revision generatedBody provenance archived}}", { id });
  const doc = briefDocument.parse(result.document);
  if (doc.archived) return null;
  if (!briefProvenance.safeParse(JSON.parse(doc.provenance || "null")).success) throw new Error("Saved page is not a Forerunner daily brief");
  return { documentId: doc.id, revision: doc.revision, slug, href: `/apps/wiki-map/p/${encodeURIComponent(slug)}?revision=${doc.revision}`, markdown: doc.generatedBody, status: "incomplete" as const, date, timezone: zone };
}

/** A homepage snapshot from saved, authorized reports. It never starts generation. */
export async function readDailyHome(db: Database, identity: AppIdentity, host: Host, raw: z.input<typeof dailyHomeInput>, now = Date.now()) {
  requireEditor(identity);
  if (identity.owner.kind !== "user" || identity.owner.id !== identity.userId) throw new Response("Daily home requires your personal installation", { status: 403 });
  const input = dailyHomeInput.parse(raw);
  const schedule = await dailyBriefSchedule(host, identity);
  const zone = timezone.parse(input.timezone ?? schedule?.timezone ?? "UTC");
  const { date, yesterday, weekStart, weekEnd, weekDates } = dailyHomeDates(now, zone);
  const warnings: string[] = [];
  const readBrief = async (day: string) => {
    try { return await savedBrief(host, identity, day, zone); }
    catch { warnings.push(`The saved daily brief for ${day} could not be read.`); return null; }
  };
  const [brief, previousBrief, priorities, priorDay, ...weekDays] = await Promise.all([
    readBrief(date), readBrief(yesterday), listItems(db, identity),
    readDayReview(db, identity, host, { date: yesterday, timezone: zone }, now),
    ...(input.includeHistory ? weekDates.map(day => readDayReview(db, identity, host, { date: day, timezone: zone }, now)) : []),
  ]);
  if (!schedule) warnings.push("The personal daily brief schedule has not been set up.");
  if (!brief) warnings.push(`No saved daily brief is available for ${date}.`);
  return { date, timezone: zone, scheduleSetupRequired: !schedule, schedule, brief, previousBrief,
    priorities: priorities.filter(item => item.status !== "done").slice(0, 30).map(item => ({ id: item.id, title: item.title, category: item.category, status: item.status, dueDate: item.dueDate })),
    yesterday: priorDay, previousWeek: { startDate: weekStart, endDate: weekEnd, days: weekDays }, historyIncluded: input.includeHistory, warnings };
}
