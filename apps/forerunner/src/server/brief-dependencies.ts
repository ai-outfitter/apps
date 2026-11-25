import type { InstallationSchedule, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { cut } from "@ai-outfitter/app-sdk/untrusted-text";
import { z } from "zod";
import { discoveryWorkflow } from "./schedule";
import { localDate } from "./review-period";

const outcome = z.object({ status: z.string(), entries: z.number().int().nonnegative().optional(), suggestions: z.number().int().nonnegative().optional() });
export type DiscoveryReceipt = { id: string; label: string; entries?: number; suggestions?: number };

export async function briefDependencies(
  host: WorkflowHost<"interactive">, schedules: InstallationSchedule[], date: string, timezone: string, now: number,
) {
  const discovery = schedules.filter(row => row.workflowId === discoveryWorkflow);
  const current = (at: number) => localDate(at, timezone) === date;
  const gaps: string[] = [];
  const receipts: DiscoveryReceipt[] = [];
  let waiting = false;
  if (!discovery.length) gaps.push("Discovery: no connected accounts have a saved discovery schedule.");
  const results = await Promise.all(discovery.map(async row => {
    const source = cut(String(row.inputs["analyze.inputs.label"] || row.inputs["analyze.inputs.provider"] || "Connected account"), 100);
    if (!row.enabled) return { gap: `Discovery (${source}): the schedule is disabled.` };
    const failure = /^(failed|skipped|declined)(:|$)/.test(row.lastOutcome ?? "");
    if ((row.lastRunAt === null || !current(row.lastRunAt)) && !current(row.nextRunAt)) {
      return { gap: failure
        ? `Discovery (${source}): the latest scheduler result was a failure or decline, and no result was recorded for this reporting day.`
        : `Discovery (${source}): no occurrence was scheduled for this reporting day.` };
    }
    if (row.lastRunAt !== null && current(row.lastRunAt) && failure)
      return { gap: `Discovery (${source}): this morning's occurrence failed or was declined.` };
    if (!row.lastRunId || row.lastRunAt === null || !current(row.lastRunAt))
      return { waiting: true, gap: `Discovery (${source}): this morning's occurrence has no result yet.` };
    const run = await host.call("workflow.read", { id: row.lastRunId }).catch(() => null);
    const analyze = run?.outputs["analyze.outputs.result"];
    const suggestions = run?.outputs["suggestions.outputs.result"];
    const analysis = outcome.safeParse(analyze?.value).data;
    const suggestion = outcome.safeParse(suggestions?.value).data;
    const status = analysis?.status;
    const suggestionStatus = suggestion?.status;
    if (run?.run.status === "failed" || status === "failed" || suggestionStatus === "failed" || (!run && row.lastOutcome !== "started"))
      return { gap: `Discovery (${source}): this morning's occurrence failed or was declined.` };
    if ((!run || run.run.status === "running") && (current(now) || current(row.nextRunAt)))
      return { waiting: true, gap: `Discovery (${source}): this morning's occurrence still has no final result.` };
    if (!analyze?.complete || status !== "ready")
      return { gap: `Discovery (${source}): this morning's occurrence did not record a completed result.` };
    if (!suggestions?.complete || !["ready", "skipped"].includes(suggestionStatus ?? ""))
      return { gap: `Discovery (${source}): this morning's occurrence did not record a completed suggestions result.` };
    return { receipt: { id: row.lastRunId, label: source, entries: analysis?.entries, suggestions: suggestion?.suggestions } };
  }));
  for (const result of results) {
    waiting ||= result.waiting === true;
    if (result.gap) gaps.push(result.gap);
    if (result.receipt) receipts.push(result.receipt);
  }
  return { waiting, gaps, receipts };
}
