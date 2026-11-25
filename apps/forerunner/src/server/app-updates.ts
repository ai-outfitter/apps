import { z } from "zod";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";

const update = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  slug: z.string(),
  scope: z.string(),
  app: z.string(),
  summary: z.string(),
  complete: z.boolean(),
  timezone: z.string(),
});
const result = z.object({
  data: z.object({ dailyAppUpdates: z.array(update) }),
  next: z.string().optional(),
});
export type AppUpdates = { rows: z.infer<typeof update>[]; complete: boolean };

export async function readAppUpdates(
  host: WorkflowHost<"interactive">,
  date: string,
): Promise<AppUpdates> {
  const rows: AppUpdates["rows"] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = result.parse(
        await host.call("platform.document", {
          app: "wiki-map",
          document: "DailyAppUpdates",
          kind: "query",
          variables: { date, limit: 50, ...(cursor ? { cursor } : {}) },
        }),
      );
      rows.push(...page.data.dailyAppUpdates);
      cursor = page.next;
      if (cursor) {
        if (seen.has(cursor)) return { rows, complete: false };
        seen.add(cursor);
      }
    } while (cursor);
    return { rows, complete: true };
  } catch {
    return { rows, complete: false };
  }
}

const wikiRevision = z.object({
  id: z.string(), slug: z.string().nullable().optional(), revision: z.number().int().positive(),
  title: z.string(), createdAt: z.iso.datetime(), scope: z.string(),
  store: z.enum(["document", "legacy"]),
});
const revisionPage = z.object({
  data: z.object({ wikiRevisionActivity: z.array(wikiRevision) }),
  next: z.string().optional(),
});
export type WikiActivity = { rows: z.infer<typeof wikiRevision>[]; complete: boolean };

export async function readWikiActivity(host: WorkflowHost<"interactive">, period: { start: number; end: number }): Promise<WikiActivity> {
  const rows: WikiActivity["rows"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const result = revisionPage.parse(await host.call("platform.document", {
        app: "wiki-map", document: "WikiRevisionActivity", kind: "query",
        variables: { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString(), limit: 20, ...(cursor ? { cursor } : {}) },
      }));
      rows.push(...result.data.wikiRevisionActivity);
      cursor = result.next;
      if (cursor) {
        if (cursors.has(cursor) || rows.length >= 40) return { rows: rows.slice(0, 40), complete: false };
        cursors.add(cursor);
      }
    } while (cursor);
    return { rows: rows.slice(0, 40), complete: rows.length <= 40 };
  } catch {
    return { rows, complete: false };
  }
}
