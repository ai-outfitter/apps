// A throwaway installed app that owns workflow policy only through the public
// workflow host SDK. It implements every phase and calls every operation, so the
// platform's dispatch and host contract are proven without any product app.
// The platform-defined phases (event, prepare, finalize) take the payloads the
// platform really sends; the others take inputs naming the run, binding and
// values to use. Results echo what the host returned so tests can assert on
// both sides of the boundary.
import { respond } from "@ai-outfitter/app-sdk/server";
import {
  eventInput,
  finalizeInput,
  invocationInput,
  type PhaseInput,
  prepareInput,
  scheduleInput,
  type WorkflowHostResult,
  type WorkflowHost,
  type WorkflowHostStub,
  workflowHost,
  workflowHostPath,
  workflowPhaseHandler,
} from "@ai-outfitter/app-sdk/workflow-host";

type Json = PhaseInput[string];
type Context = { props?: unknown };

const text = (input: PhaseInput, name: string) => {
  const value = input[name];
  if (typeof value !== "string") throw new Response(`Fixture input ${name} required`, { status: 400 });
  return value;
};
const object = (input: PhaseInput, name: string): PhaseInput => {
  const value = input[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

/** A host result as phase output; a failure keeps only its status. */
const toResult = (result: WorkflowHostResult): Json =>
  result.ok ? { ok: true, value: JSON.parse(JSON.stringify(result.value ?? null)) } : { ok: false, status: result.status };

/** A failed host call as data, so one phase can report several outcomes. */
async function outcome(work: () => Promise<unknown>): Promise<Json> {
  try {
    return toResult({ ok: true, value: await work() });
  } catch (error) {
    if (error instanceof Response) return toResult({ ok: false, status: error.status, message: "" });
    throw error;
  }
}

/** Untyped access to the raw stub, as a hostile or buggy app would use it. */
async function probe(context: Context, input: PhaseInput): Promise<Json> {
  const request = object(input, "probe");
  const stub = (context.props as { workflowHost?: WorkflowHostStub } | undefined)?.workflowHost;
  if (!stub) return { ok: false, status: 503 };
  return toResult(await stub.call(text(request, "operation"), request.input ?? {}));
}

/** Send, read and cancel one ordinary agent task on the named gateway target. */
async function routines(host: WorkflowHost<"interactive">) {
  const id = "routine";
  return {
    routines: await outcome(() => host.call("routines.list", {})),
    routineCreated: await outcome(() => host.call("routines.create", { title: "Fixture task", description: "Do the fixture task.", cadence: "Weekdays at 8am" })),
    routinePaused: await outcome(() => host.call("routines.update", { id, enabled: false })),
    platformSchedules: await outcome(() => host.call("platform.document", { document: "Schedules", variables: {} })),
  };
}

async function threads(host: WorkflowHost<"interactive">) {
  const threadId = "66666666-6666-4666-8666-666666666666", submissionId = "77777777-7777-4777-8777-777777777777";
  return {
    threadTypes: await outcome(() => host.call("threads.types", {})),
    threadList: await outcome(() => host.call("threads.list", {})),
    thread: await outcome(() => host.call("threads.get", { ref: { id: threadId } })),
    threadEntries: await outcome(() => host.call("threads.entries", { ref: { id: threadId } })),
    threadCreated: await outcome(() => host.call("threads.create", { id: threadId, type: "fixture.conversation", title: "Fixture" })),
    threadUpdated: await outcome(() => host.call("threads.update", { threadId, title: "Renamed" })),
    threadAppended: await outcome(() => host.call("threads.append", { threadId, sourceKey: "fixture:1", role: "event", parts: [{ type: "status", status: "ok" }] })),
    threadSent: await outcome(() => host.call("threads.send", { threadId, submissionId, text: "Hello" })),
    threadSubmission: await outcome(() => host.call("threads.submission", { threadId, submissionId })),
    threadCanceled: await outcome(() => host.call("threads.cancel", { threadId })),
    threadDeleted: await outcome(() => host.call("threads.delete", { threadId })),
  };
}
/** Every platform-record operation, as a member's own interactive scope reads and edits them. */
async function platformRecords(host: WorkflowHost<"interactive">) {
  const projectId = "88888888-8888-4888-8888-888888888888", connectionId = "fixture-connection";
  return {
    profile: await outcome(() => host.call("profile.read", {})),
    profileUpdated: await outcome(() => host.call("profile.update", { patch: { goals: [{ text: "Ship the fixture" }] } })),
    workProfile: await outcome(() => host.call("profile.work", {})),
    organizationContext: await outcome(() => host.call("organization.context", {})),
    projects: await outcome(() => host.call("projects.list", {})),
    project: await outcome(() => host.call("projects.get", { id: projectId })),
    google: await outcome(() => host.call("connectors.google", {})),
    googleMessages: await outcome(() => host.call("connectors.google.messages", { connectionId, query: "from:fixture" })),
    googleMessage: await outcome(() => host.call("connectors.google.message", { connectionId, messageId: "fixture-message" })),
    googleEvents: await outcome(() => host.call("connectors.google.events", { connectionId })),
    githubTools: await outcome(() => host.call("connectors.github.tools", { repositories: ["fixture/app"] })),
    githubCall: await outcome(() => host.call("connectors.github.call", { repositories: ["fixture/app"], name: "get_me", input: {} })),
    workflowProposal: await outcome(() => host.call("workflows.proposal", {})),
    workflowValidated: await outcome(() => host.call("workflows.validate", { job: "{}" })),
    catalogApps: await outcome(() => host.call("catalog.apps", {})),
    inferenceEffort: await outcome(() => host.call("inference.effort", {})),
  };
}

async function agentTask(host: WorkflowHost<"interactive">, input: PhaseInput) {
  const target = { targetId: typeof input.targetId === "string" ? input.targetId : "fixture-target", revision: "v1" };
  const correlationId = typeof input.correlationId === "string" ? input.correlationId : "33333333-3333-4333-8333-333333333333";
  const sent = await outcome(() => host.call("agent-task.send", { ...target, correlationId, prompt: "Fixture task" }));
  const taskId = sent && typeof sent === "object" && !Array.isArray(sent) && sent.ok === true &&
    sent.value && typeof sent.value === "object" && !Array.isArray(sent.value) && typeof sent.value.taskId === "string" ? sent.value.taskId : "task";
  return {
    agentTarget: await outcome(() => host.call("agent-task.inspect", target)),
    agentTask: sent,
    agentTaskStatus: await outcome(() => host.call("agent-task.status", { ...target, correlationId, taskId })),
    agentTaskCancel: await outcome(() => host.call("agent-task.cancel", { ...target, correlationId, taskId })),
  };
}

/** Operator configuration: a binding (approved twice to show reuse) and the subscription of a connection resource. */
async function configure(host: WorkflowHost<"operator">, input: PhaseInput) {
  const binding = {
    workflowId: text(input, "workflow"), actor: text(input, "actor"), label: "Fixture configured job",
    workspace: object(input, "workspace"), context: object(input, "context"),
  };
  return {
    approved: await outcome(() => host.call("binding.approve", binding)),
    reapproved: await outcome(() => host.call("binding.approve", binding)),
    subscription: await outcome(() => host.call("subscription.save", {
      connectionId: text(input, "connectionId"), resource: text(input, "resource"), workflowId: text(input, "workflow"), inputs: object(input, "inputs"),
    })),
  };
}

const phases = workflowPhaseHandler({
  // A delivery starts the run the host reserved, unless its payload asks the
  // fixture to decline it.
  async event(input, host): Promise<PhaseInput> {
    const delivery = eventInput.parse(input);
    const payload = delivery.event.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.decline === true)
      return { outcome: "declined", reason: "Fixture declined the delivery" };
    const start = {
      workflow: delivery.subscription.workflowId,
      id: delivery.runId,
      inputs: { ...delivery.subscription.inputs, [delivery.trigger.input]: payload },
    };
    const started = await host.call("workflow.start", start);
    return {
      outcome: "started",
      started,
      replay: await outcome(() => host.call("workflow.start", start)),
      pending: await host.call("workflow.pending", {}),
      receipts: await host.call("connector.receipts", { runId: started.id }),
    };
  },
  async operator(input, host) {
    const bindingId = text(input, "bindingId");
    return {
      snapshot: await host.call("snapshot", {}),
      active: await host.call("workflow.active", { slots: [text(input, "slot")] }),
      activity: await host.call("workflow.activity", { slots: [text(input, "slot")], limit: 3 }),
      references: await host.call("workflow.references", {
        selectors: [{ slot: text(input, "slot"), key: "$.key", subject: "$.subject", label: "$.label" }],
        key: text(input, "key"),
        subjects: [1],
        workflows: [text(input, "workflow")],
      }),
      repository: await host.call("repository.read", { bindingId }),
      control: await host.call("workspace.control", { bindingId, operation: "inspect-reviewer", reviewer: "fixture-reviewer" }),
      restart: await outcome(() => host.call("workflow.start", {
        workflow: text(input, "workflow"), id: text(input, "runId"), inputs: object(input, "changedInputs"),
      })),
      ...(await configure(host, object(input, "configure"))),
    };
  },
  async interactive(input, host) {
    const runId = text(input, "runId");
    const repository = await host.call("repository.read", { bindingId: text(input, "bindingId") });
    return {
      run: await host.call("workflow.read", { id: runId }),
      issue: await host.call("repository.request", { bindingId: text(input, "bindingId"), path: `${repository.path}/issues/1` }),
      approved: await outcome(() => host.call("repository.request", { connectionId: text(input, "connectionId"), path: `${repository.path}/issues/1` })),
      // A run's retained session: append one checkpoint, then read the export back.
      sessionAppended: await outcome(() => host.call("session.append", { runId, entry: { id: "fixture.checkpoint", parentId: null, kind: "checkpoint", step: "work", at: "2026-01-01T00:00:00.000Z", data: { ready: true } } })),
      session: await outcome(() => host.call("session.read", { runId })),
      // Registered tasks start under a caller-chosen run id; replaying identical inputs succeeds.
      taskStarted: await outcome(() => host.call("task.start", { task: "fixture-task", id: "66666666-6666-4666-8666-666666666666", inputs: {} })),
      published: await outcome(() => host.call("artifacts.published", { runId })),
      described: await outcome(() => host.call("artifacts.describe", { runId, ids: ["55555555-5555-4555-8555-555555555555"] })),
      // Shared threads need the package's threads.use capability; the fixture exercises the typed contract.
      ...(await threads(host)),
      ...(await platformRecords(host)),
      // The workflow's only step has an actor, and the fixture declares no issues.create: both are refused.
      collected: await outcome(() => host.call("workflow.collect", { runId, slot: "work.outputs.result", value: {} })),
      executed: await outcome(() => host.call("connector.execute", { connectionId: text(input, "connectionId"), resource: "resource", operation: "issues.create", input: {} })),
      // App-owned instructions and schema; the host only infers, frames the data and meters the run.
      inferred: await outcome(() => host.call("inference.generate", {
        runId, instructions: "Label the fixture issue.", data: { title: "Fixture issue" },
        schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
      })),
      // The fixture workflow declares no schedule trigger, so saving one is refused.
      scheduled: await outcome(() => host.call("schedule.save", { workflow: "fixture-flow", inputs: {} })),
      schedules: await outcome(() => host.call("schedules", {})),
      // The member's own routines need the package's routines.manage capability.
      ...(await routines(host)),
      // Entity access is explicitly denied unless this fixture's package
      // declares the corresponding capabilities. Exercise the typed contract
      // while retaining those refusals as observable phase results.
      entityTypes: await outcome(() => host.call("entities.types", {})),
      entities: await outcome(() => host.call("entities.list", { installationId: "provider", type: "record" })),
      entity: await outcome(() => host.call("entities.get", { installationId: "provider", type: "record", id: "record" })),
      createdEntity: await outcome(() => host.call("entities.create", { installationId: "provider", type: "record", attributes: { title: "Fixture" } })),
      updatedEntity: await outcome(() => host.call("entities.update", { installationId: "provider", type: "record", id: "record", revision: 1, attributes: { title: "Updated" } })),
      graphDocuments: await outcome(() => host.call("graph.documents", {})),
      graphDocument: await outcome(() => host.call("graph.graphql", { document: "Fixture" })),
      graphMutation: await outcome(() => host.call("graph.mutate", { document: "Fixture", installationId: "provider", variables: {} })),
      // Likewise, other apps' actions need the package's actions.invoke capability.
      currentIdentity: await outcome(() => host.call("identity.current", {})),
      identity: await outcome(() => host.call("identity.resolve", { installationId: "provider" })),
      identities: await outcome(() => host.call("identity.list", { installationId: "provider" })),
      linkedIdentity: await outcome(() => host.call("identity.link", { installationId: "provider", holderId: "holder", principalId: "fixture-principal", kind: "agent" })),
      unlinkedIdentity: await outcome(() => host.call("identity.unlink", { installationId: "provider", holderId: "holder" })),
      actions: await outcome(() => host.call("actions.list", {})),
      actionResult: await outcome(() => host.call("actions.call", { installationId: "provider", action: "record.touch", input: {} })),
      documents: await outcome(() => host.call("graph.documents", {})),
      graphResult: await outcome(() => host.call("graph.graphql", { document: "Records" })),
      // Ordinary agent tasks need the package's agent-tasks.dispatch capability
      // and a gateway target configured for this installation.
      ...(await agentTask(host, input)),
      residentRuntimes: await outcome(() => host.call("resident.runtimes", {})),
      residentInspection: await outcome(() => host.call("resident.inspect", { residentId: "44444444-4444-4444-8444-444444444444" })),
      residentReconcile: await outcome(() => host.call("resident.reconcile", { residentId: "44444444-4444-4444-8444-444444444444", desiredRevision: 1 })),
      residentTaskAuthority: await outcome(() => host.call("resident.task-authority", { userId: "owner", actor: { kind: "member", id: "owner" } })),
      // Delegated work reads need the agent-work.discover capability and an operator delegation.
      agentWork: await outcome(() => host.call("agent-work.providers", { delegation: "00000000-0000-4000-8000-0000000000a1" })),
      agentWorkList: await outcome(() => host.call("agent-work.list", { delegation: "00000000-0000-4000-8000-0000000000a1", installationId: "provider" })),
      agentWorkContext: await outcome(() => host.call("agent-work.context", {
        delegation: "00000000-0000-4000-8000-0000000000a1", installationId: "provider", id: "fixture-work", revision: 1,
      })),
      // An editor explicitly enables the fixture's scheduled invocation.
      invocation: await outcome(() => host.call("invocation.save", { name: "fixture.tick", enabled: true })),
    };
  },
  // A platform-scheduled occurrence acts for no member: it lists its own invocations.
  async invocation(input, host): Promise<PhaseInput> {
    const occurrence = invocationInput.parse(input);
    const invocations = await host.call("invocations", {});
    return { outcome: "completed", summary: `${occurrence.invocation.name}: ${invocations.length} invocation(s)` };
  },
  // A schedule's occurrence starts the run the host reserved with the
  // schedule's inputs, unless they ask the fixture to decline it.
  async schedule(input, host): Promise<PhaseInput> {
    const occurrence = scheduleInput.parse(input);
    if (occurrence.schedule.inputs.decline === true) return { outcome: "declined", reason: "Fixture declined the occurrence" };
    await host.call("workflow.start", { workflow: occurrence.schedule.workflowId, id: occurrence.runId, inputs: occurrence.schedule.inputs });
    return { outcome: "started" };
  },
  async publish(input, host) {
    const repository = await host.call("repository.read", {});
    return {
      artifact: await host.call("artifacts.publish", {
        name: "demo.png", contentType: "image/png", base64: text(input, "png"), revision: "fixture-revision",
      }),
      linked: await host.call("repository.request", {
        method: "POST", path: "/graphql",
        body: { query: "query($id: ID!) { node(id: $id) { id } }", variables: { id: repository.name } },
      }),
      published: await host.call("artifacts.published", { runId: text(input, "runId") }),
    };
  },
  // A workspace agent task, or coordination only when the binding's settings say so.
  async prepare(input, host): Promise<PhaseInput> {
    const { node, settings } = prepareInput.parse(input);
    const run = await host.call("workflow.read", { id: node.runId });
    if (settings.coordinate === true) return { mode: "coordinator" };
    return {
      mode: "agent",
      role: "triage",
      guidance: [`Fixture task for run ${run?.run.id}`],
      ...(typeof settings.previewUrl === "string"
        ? { preview: { url: settings.previewUrl, revision: typeof settings.previewRevision === "string" ? settings.previewRevision : "b".repeat(40) } }
        : {}),
    };
  },
  // Comments on the issue named by the node's own `event` input and returns the outputs.
  async finalize(input, host) {
    const { inputs, outputs, coordinator } = finalizeInput.parse(input);
    const event = object(inputs, "event");
    const issue = object(event, "issue").number;
    if (typeof issue !== "number") throw new Response("Fixture finalize needs an issue event", { status: 400 });
    const produced = object(outputs, "result");
    const summary = coordinator ? "Coordinated" : text(produced, "summary");
    const repository = await host.call("repository.read", {});
    const comment = await host.call("repository.request", {
      method: "POST", path: `${repository.path}/issues/${issue}/comments`, body: { body: summary },
    });
    const review = await host.call("workspace.control", {
      operation: "publish-review",
      reviewer: "fixture-reviewer",
      candidate: { number: 1, headSha: "a".repeat(40) },
      verdict: "approved",
      summary: "Fixture review",
    });
    return { outputs: { result: { ready: true, summary, comment } }, comment, review };
  },
});

export default {
  async fetch(request: Request, _env: unknown, context: Context): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === workflowHostPath) {
      // A probe bypasses the typed SDK to show the host, not the app, enforces scope.
      const body = request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
      const input = (body as { input?: PhaseInput } | undefined)?.input;
      if (input?.probe) return Response.json(await probe(context, input));
      return phases(request, context);
    }
    // An app API route a member reaches through the platform: interactive scope.
    const run = url.pathname.match(/^\/api\/apps\/workflow-fixture\/runs\/([^/]+)$/);
    if (run) return respond(() => workflowHost<"interactive">(context).call("workflow.read", { id: run[1] }));
    return new Response("Not found", { status: 404 });
  },
};
