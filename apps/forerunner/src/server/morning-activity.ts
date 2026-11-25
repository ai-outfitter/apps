import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { readAppUpdates, readWikiActivity } from "./app-updates";
import { reviewPeriod } from "./review-period";

type Host = WorkflowHost<"interactive">;

export const morningActivityFilters = z.object({
  date: z.iso.date().optional(), scope: z.string().min(1).max(200).default("all"),
  source: z.enum(["all", "wiki", "onto"]).default("all"),
});

export async function morningActivity(host: Host, input: z.input<typeof morningActivityFilters> & { timezone: string }, now = Date.now()) {
  const filters = morningActivityFilters.parse(input);
  const period = reviewPeriod({ date: filters.date, timezone: input.timezone }, now);
  const [apps, wiki] = await Promise.all([readAppUpdates(host, period.date), readWikiActivity(host, period)]);
  const onto = apps.rows.filter(row => row.app === "Onto" && row.timezone === period.timezone);
  const scopes = [...new Set(["personal", ...onto.map(row => row.scope), ...wiki.rows.map(row => row.scope)])].sort();
  const matchesScope = (row: {scope: string}) => filters.scope === "all" || filters.scope === row.scope;
  return {
    date: period.date, filters, scopes,
    onto: filters.source === "wiki" ? null : { rows: onto.filter(matchesScope), complete: apps.complete },
    wiki: filters.source === "onto" ? null : { rows: wiki.rows.filter(matchesScope), complete: wiki.complete },
  };
}

export function wikiRevisionHref(scope: string, slug: string, revision: number) {
  const mount = scope === "personal" ? "/apps" : `/o/${encodeURIComponent(scope)}`;
  return `${mount}/wiki-map/p/${encodeURIComponent(slug)}?revision=${revision}`;
}
