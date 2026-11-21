import { and, asc, gte, lt } from "drizzle-orm";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { scheduledAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { workshopProjects } from "./schema";

export const dailyWorkflow = "workshop-daily-update";

export function dailyUpdate(
  host: WorkflowHost<"schedule">,
  actor: AppIdentity,
  raw: unknown,
) {
  return scheduledAppUpdate(
    host,
    actor,
    raw,
    "Workshop",
    dailyWorkflow,
    async (period) => {
      const records = workshopProjects;
      const rows = await installationDatabase()
        .select({
          id: records.id,
          name: records.name,
          revision: records.revision,
          productRevisionTitle: records.productRevisionTitle,
          updatedAt: records.updatedAt,
        })
        .from(records)
        .where(
          and(
            gte(records.updatedAt, new Date(period.start).toISOString()),
            lt(records.updatedAt, new Date(period.end).toISOString()),
          ),
        )
        .orderBy(asc(records.updatedAt), asc(records.id))
        .limit(31);
      return { rows, complete: rows.length <= 30 };
    },
  );
}
