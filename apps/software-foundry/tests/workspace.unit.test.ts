import assert from "node:assert/strict";
import test from "node:test";
import { operations, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  configureFoundryWorkspaces,
  foundryChecksWorkflow,
  foundryIssueRunId,
  foundryWorkspaceWorkflow,
  launchFoundryMergeChecks,
  launchFoundryWorkspaceIssue,
  startExistingFoundryIssue,
  resolveFoundryRepository,
} from "../src/server/workspace/workspaces";

type Call = { operation: string; input: any };
const head = "b".repeat(40);
const reserved = "33333333-3333-4333-8333-333333333333";

/** A workflow host double that remembers approved bindings and subscriptions
 * as the platform would and answers the reads Foundry makes. */
function platform(provider = "github") {
  const calls: Call[] = [];
  const bindings: any[] = [];
  const subscriptions: any[] = [];
  const references: any[] = [];
  const snapshot = () => ({
    installation: { id: "foundry", activeHash: "hash", hostname: "foundry.example", workflows: [] },
    bindings: bindings.map(({ workspace: _, ...binding }) => binding),
    subscriptions,
    connections: [{ id: provider, provider, revision: "r", owner: "organization", operations: ["issues.create", "issues.comment"], repositories: ["acme/app"] }],
  });
  const answers: Record<string, (input: any) => unknown> = {
    snapshot,
    "repository.request": (input) => {
      if (input.connectionId && input.path === "/repos/acme/app") return { id: 77, full_name: "acme/app" };
      if (input.path === "/repos/acme/app/issues/5") return { number: 5, state: "open", title: "Fix it" };
      throw new Response("Unexpected request", { status: 404 });
    },
    "repository.read": (input) => {
      const binding = bindings.find((item) => item.id === input.bindingId);
      return { name: "acme/app", path: "/repos/acme/app", repositoryId: Number(binding.workspace.resource), installationId: 123, appId: 42 };
    },
    "binding.approve": (input) => {
      const binding = { id: `binding-${bindings.length + 1}`, workflowId: input.workflowId, actor: input.actor, kind: "external", label: input.label,
        revision: "one", packageHash: "hash", enabled: true, workspace: input.workspace };
      bindings.push(binding);
      return { id: binding.id, revision: "one", reused: false };
    },
    "subscription.save": (input) => {
      subscriptions.push({ id: "subscription", workflowId: input.workflowId, connectionId: input.connectionId, resource: input.resource, enabled: true, inputs: input.inputs });
      return { id: "subscription" };
    },
    "workflow.references": () => references,
    // This installation's run by ID; none exist in this double.
    "workflow.read": () => null,
    "workflow.start": (input) => ({ id: input.id, workflow: input.workflow, created: true }),
  };
  const host = {
    async call(operation: string, input: any) {
      calls.push({ operation, input });
      const answer = answers[operation];
      if (!answer) throw new Response(`Unexpected ${operation}`, { status: 403 });
      return answer(input);
    },
  } as unknown as WorkflowHost<"operator" | "interactive" | "event">;
  return { host, calls, bindings, subscriptions, references };
}

test("an organization's Forgejo connection serves configuration as GitHub does", async () => {
  const { host, calls } = platform("forgejo");
  const configured = await configureFoundryWorkspaces(host as never, "Acme/App", "vega", "gpt-6-luna", "workspace");
  assert.equal(configured.resource, "77");
  assert.ok(calls.some(({ operation, input }) => operation === "repository.request" && input.connectionId === "forgejo"));
  // Another provider never stands in for a forge.
  await assert.rejects(configureFoundryWorkspaces(platform("slack").host as never, "acme/app", "vega"), (error: Response) => error.status === 409);
});

test("configure approves every role, landing and merge-check binding, then one subscription of the role slots", async () => {
  const { host, bindings, subscriptions, calls } = platform();
  const configured = await configureFoundryWorkspaces(host as never, "acme/app", "vega");
  assert.deepEqual(configured, { subscriptionId: "subscription", repository: "acme/app", resource: "77", workflow: foundryWorkspaceWorkflow });
  assert.deepEqual(bindings.map((binding) => `${binding.workflowId}/${binding.actor}`), [
    ...["triager", "engineer", "validator", "reviewer", "repairer", "lander"].map((actor) => `${foundryWorkspaceWorkflow}/${actor}`),
    "foundry-land-reviewed-change/lander",
    `${foundryChecksWorkflow}/validator`,
  ]);
  const [{ inputs }] = subscriptions;
  assert.deepEqual(Object.keys(inputs), ["triager", "engineer", "validator", "reviewer", "repairer", "lander"].map((actor) => `triage.inputs.${actor}Binding`));
  const review = bindings.find((binding) => binding.actor === "reviewer").workspace;
  assert.equal(review.repository, "acme/app");
  assert.equal(review.connectionId, undefined, "execution resolves the repository without an organization connection binding");
  assert.deepEqual(review.graphql, ["publish", "finalize"]);
  assert.deepEqual(review.control.map((entry: { operation: string }) => entry.operation), ["inspect-reviewer", "inspect-preview-access", "publish-review", "inspect-preview"]);
  assert.equal(review.settings.role, "review");
  assert.equal(bindings.find((binding) => binding.workflowId === foundryChecksWorkflow).workspace.settings.ci, "workspace");
  assert.equal(bindings.find((binding) => binding.actor === "engineer").workspace.agentPermissions.contents, "write");
  // The subscription names the repository's connection and id; no separate issue approval is written.
  assert.deepEqual(calls.filter((call) => call.operation === "subscription.save").map((call) => [call.input.connectionId, call.input.resource]), [["github", "77"]]);
  assert.ok(!calls.some((call) => !Object.hasOwn(operations, call.operation)), "only operations the host defines");
});

test("a user's connection resolves a repository whose subscription has a separate event-routing identity", async () => {
  const { host, subscriptions } = platform();
  await configureFoundryWorkspaces(host as never, "acme/app", "vega");
  subscriptions[0].connectionId = "separate-event-route";
  const snapshot = await host.call("snapshot", {});
  const resolved = await resolveFoundryRepository(host as never, snapshot as never, "acme/app");
  assert.equal(resolved?.repo.repositoryId, 77);
  assert.equal(resolved?.subscription.connectionId, "separate-event-route");
});

test("merge checks launch under the merge-check binding configure approved", async () => {
  const { host, bindings, calls } = platform();
  await configureFoundryWorkspaces(host as never, "acme/app", "vega");
  const checker = bindings.find((binding) => binding.workflowId === foundryChecksWorkflow);
  const event = { repository: { id: 77 }, merge_group: { head_sha: head, head_ref: "gh-readonly-queue/main/pr-1" } };
  assert.deepEqual(await launchFoundryMergeChecks(host as never, "77", event, reserved), { id: reserved, workflow: foundryChecksWorkflow, created: true });
  const start = calls.filter((call) => call.operation === "workflow.start").at(-1);
  assert.equal(start?.input.inputs["validate.inputs.validatorBinding"], checker.id);
  assert.equal(start?.input.inputs["validate.inputs.previous"].candidate.headSha, head);
  await assert.rejects(launchFoundryMergeChecks(host as never, "78", event, reserved), (error: unknown) => error instanceof Response && error.status === 403);
});

test("an issue delivery starts the reserved run unless the issue already has a running run", async () => {
  const { host, references, calls } = platform();
  const subscription = { resource: "77", inputs: { "triage.inputs.triagerBinding": "binding-1" } };
  const event = { action: "opened", repository: { id: 77, full_name: "acme/app" }, issue: { number: 5 } };
  const started = await launchFoundryWorkspaceIssue(host, subscription, event, reserved);
  assert.deepEqual(started, { id: reserved, workflow: foundryWorkspaceWorkflow, created: true, existing: false });
  assert.deepEqual(calls.at(-1)?.input.inputs, { ...subscription.inputs, "triage.inputs.event": event });
  references.push({ id: "running-run", key: "77", subject: 5, label: null, status: "running", updatedAt: 1 });
  assert.equal((await launchFoundryWorkspaceIssue(host, subscription, event, reserved)).existing, true);
  await assert.rejects(launchFoundryWorkspaceIssue(host, subscription, { ...event, repository: { id: 78 } }, reserved),
    (error: unknown) => error instanceof Response && error.status === 403);
});

test("an editor's start on an existing issue uses the stable installation, repository and issue run id", async () => {
  const { host, calls } = platform();
  await configureFoundryWorkspaces(host as never, "acme/app", "vega");
  const started = await startExistingFoundryIssue(host as never, "acme/app", 5);
  assert.equal(started.id, await foundryIssueRunId("foundry", "77", 5));
  const start = calls.filter((call) => call.operation === "workflow.start").at(-1);
  assert.deepEqual(start?.input.inputs["triage.inputs.event"], { action: "opened", repository: { id: 77, full_name: "acme/app" }, issue: { number: 5, state: "open", title: "Fix it" } });
  await assert.rejects(startExistingFoundryIssue(host as never, "acme/other", 5), (error: unknown) => error instanceof Response && error.status === 409);
});


test("workspace guidance scopes repository commands and requires actual viewport captures", async () => {
  const {workspaceGuidance}=await import("../src/server/workspace/execution");
  const playground=workspaceGuidance("ai-outfitter/outfitter-playground-internal").join("\n");
  assert.doesNotMatch(playground,/build:node|anonymous-onboarding/);
  assert.match(playground,/resize_page or emulate/);
  assert.match(workspaceGuidance("ai-outfitter/webapp").join("\n"),/build:node/);
});
