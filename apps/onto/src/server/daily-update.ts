import { and, asc, gte, lt } from "drizzle-orm";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { scheduledAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { graphBatches } from "./schema";

export const dailyWorkflow = "onto-daily-update";

export function dailyUpdate(
  host: WorkflowHost<"schedule">,
  actor: AppIdentity,
  raw: unknown,
) {
  return scheduledAppUpdate(
    host,
    actor,
    raw,
    "Onto",
    dailyWorkflow,
    async (period) => {
      const records = graphBatches;
      const rows = await installationDatabase()
        .select({
          id: records.id,
          title: records.title,
          state: records.state,
          updatedAt: records.updatedAt,
        })
        .from(records)
        .where(
          and(
            gte(records.updatedAt, period.start),
            lt(records.updatedAt, period.end),
          ),
        )
        .orderBy(asc(records.updatedAt), asc(records.id))
        .limit(31);
      return { rows, complete: rows.length <= 30 };
    },
  );
}
