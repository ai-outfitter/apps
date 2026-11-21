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
