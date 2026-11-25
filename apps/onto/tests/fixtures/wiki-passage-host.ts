import assert from "node:assert/strict";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import type { Member } from "@ai-outfitter/app-test/worker";
import {
  workflowHostPath, type InstallationSchedule, type WorkflowHostScope,
} from "@ai-outfitter/app-sdk/workflow-host";
import { initializedAppWorker } from "./initialized-worker";
import { actionsPath, json, type createWikiCorpus } from "./wiki-passage-corpus";

export const indexWorkflow = "wiki-passage-index";
type Corpus = Awaited<ReturnType<typeof createWikiCorpus>>;
type HostInput = {
  installationId?: string;
  action?: string;
  input?: unknown;
  readOnly?: boolean;
  workflow?: string;
  id?: string;
  inputs?: InstallationSchedule["inputs"];
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  runId?: string;
  step?: string;
  data?: unknown;
  slot?: string;
  value?: unknown;
};
type HostCall = { operation: string; input: HostInput; status?: number; result?: unknown };
const ontoPackage = appArtifact(new URL("../..", import.meta.url), "operational");
const ok = (value: unknown) => ({ ok: true as const, value });
const failure = (status: number, message: string) => ({ ok: false as const, status, message });

export async function createOntoHarness(
  owner: Member, corpus: Corpus, infer: (data: unknown) => unknown,
) {
  const calls: HostCall[] = [];
  const installationId = `onto-${owner.organizationId}`;
  const schedules = new Map<string, InstallationSchedule>();
  const reservations = new Map<string, string>();
  const started = new Map<string, string>();
  const deniedWikiUsers = new Set<string>();
  let inventoryFailures = 0;
  const app = await initializedAppWorker(owner, "onto", ontoPackage, installationId, {
    workflowHost: scope => ({
      call: async (operation, raw) => {
        const input = raw as HostInput;
        const call = { operation, input } as HostCall;
        calls.push(call);
        if (scope.organizationId !== owner.organizationId || scope.installationId !== installationId) {
          return failure(404, "Unknown workflow scope");
        }
        switch (operation) {
          case "actions.call": {
            // Match the platform boundary before forwarding any app identity.
            if (input.installationId !== corpus.wiki.installationId) {
              call.status = 404;
              return failure(404, "Unknown Wiki installation");
            }
            if (!input.readOnly || !input.action?.startsWith("passage.")) {
              return failure(403, "Expected a Wiki passage read");
            }
            if (deniedWikiUsers.has(scope.userId)) {
              call.status = 403;
              return failure(403, "Wiki access denied");
            }
            if (input.action === "passage.sources" && inventoryFailures > 0) {
              inventoryFailures--;
              call.status = 503;
              return failure(503, "Synthetic transient source transport failure");
            }
            const response = await corpus.wiki.call(actionsPath, {
              ...owner, userId: scope.userId, role: scope.userId === owner.userId ? owner.role : "member",
              actor: { kind: "app", id: scope.installationId },
            }, {
              method: "POST",
              body: { action: input.action, input: input.input, access: "read" },
            });
            call.status = response.status;
            if (!response.ok) return failure(response.status, await response.text());
            const value = await response.json();
            if (input.action === "passage.read") call.result = value;
            return ok(value);
          }
          case "schedule.save": {
            if (scope.userId !== owner.userId || scope.phase !== "interactive" || !input.workflow) {
              return failure(403, "Expected an interactive editor");
            }
            const schedule = makeSchedule(input.workflow, input);
            schedules.set(input.workflow, schedule);
            return ok(schedule);
          }
          case "schedules":
            return ok([...schedules.values()]);
          case "workflow.start": {
            const scheduled = scope.runId ? reservations.get(scope.runId) : undefined;
            if (!input.id || !input.workflow || scheduled !== input.workflow ||
                (scheduled === indexWorkflow && scope.runId !== input.id)) {
              return failure(403, "Start must use the occurrence's workflow and the index's reserved run");
            }
            const prior = started.get(input.id);
            if (prior && prior !== scheduled) return failure(409, "Run belongs to another workflow");
            const created = !prior;
            started.set(input.id, scheduled);
            return ok({ id: input.id, workflow: input.workflow, created });
          }
          case "workflow.collect":
          case "inference.generate": {
            const scheduled = scope.runId ? reservations.get(scope.runId) : undefined;
            if (!input.runId || !scheduled || started.get(input.runId) !== scheduled) {
              return failure(403, "Unknown running occurrence");
            }
            if (operation === "workflow.collect") {
              return ok({ run: "complete", steps: { index: "complete", review: "complete" } });
            }
            if (scheduled === "batch-review") {
              return ok({ output: { summary: "Synthetic steward response.", findings: [] } });
            }
            const data = input.data as { passages: Array<{ id: string }> };
            return ok({ output: { results: data.passages.map(passage => ({
              passageId: passage.id,
              ...(infer(passage) as { suggestions: unknown[] }),
            })) } });
          }
          default:
            return failure(400, `Unexpected fixture host operation ${operation}`);
        }
      },
    }),
  });

  function makeSchedule(workflowId: string, input: HostInput): InstallationSchedule {
    return {
      id: `schedule-${workflowId}`, workflowId, inputs: input.inputs ?? {}, enabled: input.enabled ?? true, createdBy: owner.userId,
      timezone: input.timezone ?? "UTC", cron: input.cron ?? "0 * * * *", connectionId: null, resource: null,
      nextRunAt: Date.now(), lastRunAt: null, lastRunId: null, lastOutcome: null,
    };
  }
  function scope(member: Member): WorkflowHostScope {
    assert.equal(member.organizationId, owner.organizationId);
    return {
      organizationId: member.organizationId, userId: member.userId, installationId,
      packageHash: "synthetic-package", phase: "interactive",
      ...(member.actor ? { originActor: member.actor, viaActor: member.actor } : { initiation: "member" }),
      expiresAt: Date.now() + 300_000,
    };
  }
  const action = (name: string, input: object, member = owner, access?: "read") => app.call(actionsPath, member, {
    method: "POST", body: { action: name, input, access }, workflowHost: scope(member),
  });
  async function occurrence(workflowId = indexWorkflow, {
    runId = crypto.randomUUID(), member = owner, trusted = true,
  }: { runId?: string; member?: Member; trusted?: boolean } = {}) {
    const schedule = schedules.get(workflowId);
    assert.ok(schedule, `Save the ${workflowId} schedule first`);
    reservations.set(runId, workflowId);
    return app.call(workflowHostPath, member, {
      method: "POST",
      body: { phase: "schedule", input: { schedule, runId, scheduledFor: Date.now() } },
      workflowHost: trusted ? {
        ...scope(member), initiation: undefined, phase: "schedule", scheduleId: schedule.id, runId,
      } : undefined,
    });
  }

  return {
    app, action, occurrence, calls, schedules,
    reviewCard(member: Member) {
      return app.call("/api/internal/home-cards/v1/read", member, {
        method: "POST", body: { cardId: "changes-review", size: "medium" }, workflowHost: scope(member),
      });
    },
    review(batchId: string, verdict: "approve" | "reject" | "request_changes" = "approve", refs?: string[], feedback?: { expectedVersion: number; comment: string }) {
      return app.call("/api/apps/onto/batches/review", owner, {
        method: "POST", body: { batchId, verdict, refs, ...feedback }, workflowHost: scope(owner),
      });
    },
    read<T>(name: string, input: object, member = owner) {
      return action(name, input, member).then(json<T>);
    },
    failNextInventory() { inventoryFailures++; },
    denyWikiAccess(member: Member) { deniedWikiUsers.add(member.userId); },
  };
}
