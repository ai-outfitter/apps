import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { scheduledAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { graphBatches, graphRevisions } from "./schema";

export const dailyWorkflow = "onto-daily-update";

export async function dailyOntoActivity(db: ReturnType<typeof installationDatabase>, period: { start: number; end: number }) {
  const [commits, proposals] = await Promise.all([
    db.select({
      kind: graphRevisions.kind,
      id: graphRevisions.recordId,
      revision: graphRevisions.revision,
      batchId: graphRevisions.batchId,
      title: graphBatches.title,
      at: graphRevisions.createdAt,
    }).from(graphRevisions).leftJoin(graphBatches, eq(graphBatches.id, graphRevisions.batchId))
      .where(and(gte(graphRevisions.createdAt, period.start), lt(graphRevisions.createdAt, period.end)))
      .orderBy(asc(graphRevisions.createdAt), asc(graphRevisions.kind), asc(graphRevisions.recordId), asc(graphRevisions.revision)).limit(31),
    db.select({ id: graphBatches.id, title: graphBatches.title, state: graphBatches.state, at: graphBatches.updatedAt })
      .from(graphBatches)
      .where(and(gte(graphBatches.updatedAt, period.start), lt(graphBatches.updatedAt, period.end),
        inArray(graphBatches.state, ["open", "awaiting_review", "rejected"])))
      .orderBy(asc(graphBatches.updatedAt), asc(graphBatches.id)).limit(31),
  ]);
  const rows = [
    ...commits.map(row => ({ ...row, title: row.title?.slice(0, 140), activity: "committed revision" })),
    ...proposals.map(row => ({ ...row, title: row.title.slice(0, 140), activity: "batch updated; current proposal state" })),
  ];
  const number = (n: number) => n === 31 ? "at least 31" : String(n);
  const pending = proposals.filter(row => row.state !== "rejected");
  const rejected = proposals.length - pending.length;
  const proposalCounts = proposals.length === 31
    ? `At least ${pending.length} pending and ${rejected} rejected batch updates observed.`
    : `${pending.length} pending and ${rejected} rejected batch updates observed.`;
  const titles = [...new Set(commits.map(row => row.title).filter(Boolean))].slice(0, 3).map(title => title!.slice(0, 85));
  return {
    rows,
    complete: rows.length <= 30,
    summary: `${number(commits.length)} committed record revisions by commit time.${titles.length ? ` Batches include ${titles.join("; ")}.` : ""} ${proposalCounts} Proposal counts use current states, separate from committed revisions.`,
  };
}

export function dailyUpdate(host: WorkflowHost<"schedule">, actor: AppIdentity, raw: unknown) {
  return scheduledAppUpdate(host, actor, raw, "Onto", dailyWorkflow, period => dailyOntoActivity(installationDatabase(), period));
}
