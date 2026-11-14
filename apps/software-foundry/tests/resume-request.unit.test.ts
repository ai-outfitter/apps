import assert from "node:assert/strict";
import test from "node:test";
import { resumeRequest } from "../src/server/requests";

const failedRun = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const resumeId = "33333333-3333-4333-8333-333333333333";

function context(issueUrl: string | null, status = "failed") {
  const started: any[] = [];
  const event = { action: "opened", repository: { id: 77, full_name: "acme/app" }, issue: { number: 5 } };
  const answers: Record<string, (input: any) => unknown> = {
    snapshot: () => ({ installation: { id: "foundry", activeHash: "h", hostname: "f.example", workflows: [] },
      bindings: [{ id: "b1", workflowId: "issue-to-merge-actions-ci", actor: "triager", enabled: true }],
      subscriptions: [{ id: "s", workflowId: "issue-to-merge-actions-ci", connectionId: "github", resource: "77", enabled: true, inputs: { "triage.inputs.triagerBinding": "b1" } }],
      connections: [{ id: "github", provider: "github", revision: "r", owner: "organization", operations: [], repositories: ["acme/app"] }] }),
    "repository.request": (input) => input.path === "/repos/acme/app" ? { id: 77, full_name: "acme/app" } : { number: 5, state: "open", title: "Fix" },
    "repository.read": () => ({ name: "acme/app", path: "/repos/acme/app", repositoryId: 77 }),
    "workflow.references": () => [{ id: failedRun, status }],
    "workflow.read": (input) => input.id === failedRun
      ? { run: { id: failedRun, workflowId: "issue-to-merge-actions-ci", status: "failed" }, inputs: { "triage.inputs.event": event }, outputs: {}, attempts: [], readiness: {} }
      : null,
    "workflow.start": (input) => { started.push(input); return { id: input.id, workflow: input.workflow, created: true }; },
  };
  const host = { call: async (operation: string, input: any) => answers[operation](input) };
  return { started, value: { identity: { userId: "u", canEdit: true }, host: () => host,
    db: () => ({ all: async () => [{ issue_url: issueUrl }] }) } as never };
}

test("resume starts the request's failed run again on the same issue", async () => {
  const c = context("https://github.com/acme/app/issues/5");
  const resumed = await resumeRequest(c.value, { requestId, resumeId });
  assert.equal(resumed.run.existing, false);
  assert.equal(c.started.length, 1);
  assert.equal(c.started[0].inputs["triage.inputs.event"].previousRunId, failedRun);
});

test("resume returns a running run instead of restarting, and needs a recorded issue", async () => {
  const running = context("https://github.com/acme/app/issues/5", "running");
  assert.deepEqual((await resumeRequest(running.value, { requestId, resumeId })).run, { id: failedRun, existing: true, status: "running" });
  assert.equal(running.started.length, 0);
  await assert.rejects(resumeRequest(context(null).value, { requestId, resumeId }), (error: Response) => error.status === 404);
});
