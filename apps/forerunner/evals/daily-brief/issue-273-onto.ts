import { parseAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import { workflowHostPath } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { oceanMorning, timezone, ontoBatches, ontoRevisions } from "./issue-273-fixtures";

const member = { userId: "fixture-member", owner: { kind: "user" as const, id: "fixture-member" }, role: "owner", organizationId: "" };

/** Run Onto's installed producer over an isolated database seeded with the replay. */
export async function collectOnto(confirmedEmpty: boolean, generate: (step: InferenceStep) => Promise<unknown>) {
  const installationId = "fixture-onto";
  const schedule = { id: "onto-schedule", workflowId: "onto-daily-update", inputs: {}, connectionId: null, resource: null };
  const scheduledFor = Date.parse(oceanMorning.briefAt) - 15 * 60_000;
  const runId = "00000000-0000-4000-8000-000000000001";
  const receipt: { writes: { slug: string; generatedBody: string }[]; phaseCalls: string[]; prompt?: InferenceStep } = { writes: [], phaseCalls: [] };
  const app = await appWorker("onto", appArtifact(new URL("../../../onto", import.meta.url), "operational"), installationId, {
    workflowHost: () => ({ async call(operation, input) {
      receipt.phaseCalls.push(operation);
      const ok = (value: unknown) => ({ ok: true as const, value });
      switch (operation) {
        case "schedules": return ok([{ ...schedule, timezone, cron: "0 2 * * *", createdBy: member.userId,
          enabled: true, nextRunAt: scheduledFor, lastRunAt: null, lastRunId: null, lastOutcome: null }]);
        case "workflow.start": return ok({ id: runId, workflow: schedule.workflowId, created: true });
        case "workflow.collect": return ok({ run: "complete", steps: { summarize: "complete" } });
        case "inference.generate":
          receipt.prompt = input as InferenceStep;
          return ok({ output: await generate(receipt.prompt) });
        case "actions.call": {
          const args = input as { input: { query: string; variables: { input: { slug: string; generatedBody: string } } } };
          if (args.input.query.includes("SavedPages")) return ok({ data: { p0: null } });
          if (args.input.query.includes("SaveGeneratedDocument")) {
            receipt.writes.push(args.input.variables.input);
            return ok({ data: { saveGeneratedDocument: { id: "onto-daily-document", revision: 1 } } });
          }
          break;
        }
      }
      return { ok: false, status: 500, message: "Unexpected host operation in installed Onto replay" };
    } }),
  });
  try {
    if (!confirmedEmpty) {
      const batch = app.database.prepare("insert into graph_batches (id,title,state,policy,openedBy,openedVia,createdAt,updatedAt,expiresAt) values (?,?,?,'{}','fixture','fixture',?,?,?)");
      const revision = app.database.prepare("insert into graph_revisions (kind,recordId,revision,batchId,proposedBy,approval,snapshot,createdAt) values (?,?,?,?,'fixture','{}','{}',?)");
      await app.database.batch([
        ...ontoBatches.map(row => batch.bind(row.id, row.title, row.state, row.updatedAt - 86_400_000, row.updatedAt, row.updatedAt + 86_400_000)),
        ...ontoRevisions.map(row => revision.bind(row.kind, row.recordId, row.revision, row.batchId, row.createdAt)),
      ]);
    }
    const response = await app.call(workflowHostPath, member, {
      method: "POST", body: { phase: "schedule", input: { runId, scheduledFor, schedule, trigger: "clock" } },
      workflowHost: { phase: "schedule", userId: member.userId, installationId, scheduleId: schedule.id,
        organizationId: null, packageHash: "fixture-package", expiresAt: Date.now() + 180_000 },
    });
    if (!response.ok) throw new Error(`Installed Onto producer returned ${response.status}`);
    const write = receipt.writes[0];
    if (!write) throw new Error("Onto did not save its daily page");
    return { ...receipt, update: {
      id: "onto-daily-document", revision: 1, slug: write.slug, scope: "personal", app: "Onto", timezone, ...parseAppUpdate(write.generatedBody),
    } };
  } finally {
    await app.dispose();
  }
}
export type InferenceStep = { runId: string; step: string; instructions: string; data: unknown; schema: Record<string, unknown> };
