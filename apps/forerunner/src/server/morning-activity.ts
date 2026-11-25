import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { readAppUpdates, readWikiActivity } from "./app-updates";
import { currentMemberships } from "./day-review";
import { reviewPeriod } from "./review-period";

type Host = WorkflowHost<"interactive">;

export const morningActivityFilters = z.object({
  date: z.iso.date().optional(), scope: z.string().min(1).max(200).default("all"),
  source: z.enum(["all", "wiki", "onto"]).default("all"),
});

export async function morningActivity(host: Host, input: z.input<typeof morningActivityFilters> & { timezone: string }, now = Date.now()) {
  const filters = morningActivityFilters.parse(input);
  const period = reviewPeriod({ date: filters.date, timezone: input.timezone }, now);
  const [apps, wiki, memberships] = await Promise.all([readAppUpdates(host, period.date), readWikiActivity(host, period), currentMemberships(host).catch(() => [])]);
  const onto = apps.rows.filter(row => row.app === "Onto" && row.timezone === period.timezone);
  const scopes = [...new Set(["personal", ...memberships.filter(org => org.appSlugs.includes("onto") || org.appSlugs.includes("wiki-map")).map(org => org.slug), ...onto.map(row => row.scope), ...wiki.rows.map(row => row.scope)])].sort();
  const matchesScope = (row: {scope: string}) => filters.scope === "all" || filters.scope === row.scope;
  return {
    date: period.date, filters, scopes,
    onto: filters.source === "wiki" ? null : { rows: onto.filter(matchesScope), complete: apps.complete },
    wiki: filters.source === "onto" ? null : { rows: wiki.rows.filter(matchesScope), complete: wiki.complete },
  };
}
