// The built operational worker's own design agent and concept generator: each
// turn starts a run of its workflow and asks the workflow host for the model
// answer or image, then saves the project in the installation's database.
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowHostResult, WorkflowHostScope, WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { Project } from "../src/lib/project";

const member = { userId: "member", organizationId: "org", role: "member" };
const installationId = "design";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const plan = (radius: number) => ({ version: 1, units: "mm", features: [
  { kind: "box", mode: "add", origin: [-30, -20, 0], size: [60, 40, 20] },
  { kind: "cylinder", mode: "cut", base: [0, 0, 0], radius, height: 20, axis: "z" },
] });

/** A workflow host that answers runs, model answers and images, and records every call.
 * It keeps the runs it started, as the platform does, so a started task can be read back. */
function host() {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const runs = new Map<string, { run: Record<string, unknown>; inputs: Record<string, unknown>; outputs: Record<string, { value: unknown; complete: boolean }> }>();
  const claim = (id: string, workflowId: string, inputs: Record<string, unknown>) => {
    const created = !runs.has(id);
    if (created) runs.set(id, { run: { id, workflowId, status: "running", createdBy: member.userId, createdAt: 1_000, updatedAt: 1_000, visibility: "organization" }, inputs, outputs: {} });
    return created;
  };
  let answer: unknown = { name: "Cable clip", rationale: "A block with a hole.", plan: plan(5) };
  const ok = (value: unknown): WorkflowHostResult => ({ ok: true, value });
  return {
    calls,
    answer: (next: unknown) => { answer = next; },
    host: (_scope: WorkflowHostScope): WorkflowHostStub => ({
      async call(operation, raw) {
        const input = raw as Record<string, unknown>;
        calls.push({ operation, input });
        if (operation === "workflow.start") return ok({ id: input.id, workflow: input.workflow, created: claim(String(input.id), String(input.workflow), input.inputs as Record<string, unknown>) });
        if (operation === "task.start") return ok({ id: input.id, task: input.task, created: claim(String(input.id), String(input.task), { "design.inputs.request": input.inputs }) });
        if (operation === "workflow.read") {
          const run = runs.get(String(input.id));
          return ok(run ? { ...run, readiness: { run: String(run.run.status), steps: {} }, attempts: [] } : null);
        }
        if (operation === "inference.generate") return ok({ output: answer });
        if (operation === "inference.image") return ok({ contentType: "image/png", base64: png, model: "gpt-image-1" });
        if (operation === "workflow.collect") {
          const run = runs.get(String(input.runId));
          if (run) Object.assign(run, { run: { ...run.run, status: "complete", updatedAt: 2_000 }, outputs: { [String(input.slot)]: { value: input.value, complete: true } } });
          return ok({ run: "complete", steps: {} });
        }
        return { ok: false, status: 400, message: `Unexpected ${operation}` };
      },
    }),
  };
}
const scope = (): WorkflowHostScope => ({ organizationId: "org", installationId, userId: member.userId, packageHash: "hash", phase: "interactive", expiresAt: Date.now() + 60_000, initiation: "member" });

test("design: a request and a follow-up run the design workflow and save revisions; a bad answer saves nothing", async () => {
  const double = host();
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), installationId, { workflowHost: double.host });
  try {
    const design = (body: unknown) => app.call("/api/apps/workshop/agent", member, { method: "POST", body, workflowHost: scope() });
    const created = await design({ message: "A 60 x 40 x 20 mm cable clip with a 10 mm hole" });
    assert.equal(created.status, 200, await created.clone().text());
    const first = (await created.json()) as { project: Project; rationale: string };
    assert.deepEqual([first.project.name, first.project.revision, first.rationale], ["Cable clip", 1, "A block with a hole."]);
    const [start, generate, collect] = double.calls;
    assert.deepEqual([start.operation, start.input.workflow], ["workflow.start", "workshop-design"]);
    assert.deepEqual(start.input.inputs, { "design.inputs.request": { message: "A 60 x 40 x 20 mm cable clip with a 10 mm hole" } });
    assert.deepEqual([generate.input.runId, generate.input.step, generate.input.data], [start.input.id, "design", { request: "A 60 x 40 x 20 mm cable clip with a 10 mm hole" }]);
    assert.match(String(generate.input.instructions), /parametric CAD planner/);
    assert.deepEqual([collect.input.slot, (collect.input.value as { revision: number }).revision], ["design.outputs.design", 1]);

    double.answer({ name: "Cable clip", rationale: "Widened to 12 mm.", plan: plan(6) });
    const followed = await design({ message: "Make the hole 12 mm", projectId: first.project.id, revision: 1 });
    assert.equal(followed.status, 200, await followed.clone().text());
    const second = ((await followed.json()) as { project: Project }).project;
    assert.equal(second.revision, 2);
    assert.equal((second.cadPlan?.features[1] as { radius: number }).radius, 6);
    assert.equal((double.calls.at(-2)?.input.data as { followUp: string }).followUp, "Make the hole 12 mm");

    // A stale revision is refused before any run starts; an answer outside the CAD plan contract saves nothing.
    const before = double.calls.length;
    assert.equal((await design({ message: "Again", projectId: first.project.id, revision: 1 })).status, 409);
    assert.equal(double.calls.length, before);
    double.answer({ name: "Bad", rationale: "Starts with a cut.", plan: { ...plan(6), features: [plan(6).features[1]] } });
    assert.equal((await design({ message: "Again", projectId: first.project.id, revision: 2 })).status, 502);
    const saved = (await (await app.call(`/api/apps/workshop/projects/${first.project.id}`, member)).json()) as Project;
    assert.equal(saved.revision, 2);
    assert.equal((await design({ message: "x", projectId: first.project.id })).status, 400);
  } finally {
    await app.dispose();
  }
});

test("design: StartWorkshopDesign starts a task run, the platform's dispatch designs on it, and WorkshopDesignRun reads it back", async () => {
  const double = host();
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), installationId, { workflowHost: double.host });
  const owner = { ...member, role: "owner" };
  type Run = { id: string; status: string; created?: boolean; design: { projectId: string; revision: number; name: string } | null };
  type Answer = { data: Record<string, Run> | null; errors?: { message: string; extensions?: { status?: number } }[] };
  try {
    // As the platform's graph_mutate and graph_query reach the app: its reserved actions route.
    const action = async (name: "graph.mutate" | "graph.graphql", query: string, input: unknown) => {
      const response = await app.call("/api/internal/actions/v1/call", owner, { method: "POST", workflowHost: scope(), body: { action: name, input: { query, variables: { input } } } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as Answer;
    };
    const start = (input: unknown) => action("graph.mutate", "mutation StartWorkshopDesign($input: StartWorkshopDesignInput!) { startWorkshopDesign(input: $input) }", input);
    const read = (id: string) => action("graph.graphql", "query WorkshopDesignRun($input: WorkshopDesignRunInput!) { workshopDesignRun(input: $input) }", { id });
    // The task as the platform dispatches it to the workflow host route's interactive phase.
    const dispatch = (runId: string, inputs: unknown) =>
      app.call("/api/internal/workflow-host/v1", owner, { method: "POST", workflowHost: scope(), body: { phase: "interactive", input: { runId, task: "workshop-design", inputs } } });

    const message = "A 60 x 40 x 20 mm cable clip with a 10 mm hole";
    const started = (await start({ message })).data?.startWorkshopDesign as Run;
    assert.deepEqual([started.status, started.created, started.design], ["running", true, null]);
    const task = double.calls.find((call) => call.operation === "task.start");
    assert.deepEqual([task?.input.task, task?.input.id, task?.input.inputs], ["workshop-design", started.id, { message }]);
    // Starting answers before any model call, and saves nothing yet.
    assert.equal(double.calls.some((call) => call.operation === "inference.generate"), false);
    assert.deepEqual(await (await app.call("/api/apps/workshop/projects", owner)).json(), []);

    const designed = await dispatch(started.id, { message });
    assert.equal(designed.status, 200, await designed.clone().text());
    const design = (await designed.json()) as { projectId: string; revision: number; name: string };
    assert.deepEqual([design.name, design.revision], ["Cable clip", 1]);
    // The turn designs on the run the start claimed: no second run.
    assert.equal(double.calls.some((call) => call.operation === "workflow.start"), false);
    assert.equal(double.calls.find((call) => call.operation === "inference.generate")?.input.runId, started.id);
    const finished = (await read(started.id)).data?.workshopDesignRun as Run;
    assert.deepEqual([finished.status, finished.design?.projectId, finished.design?.revision], ["complete", design.projectId, 1]);

    // A follow-up names the revision the caller saw; the same id retried starts nothing twice.
    double.answer({ name: "Cable clip", rationale: "Widened to 12 mm.", plan: plan(6) });
    const followUp = { id: crypto.randomUUID(), message: "Make the hole 12 mm", projectId: design.projectId, revision: 1 };
    const second = (await start(followUp)).data?.startWorkshopDesign as Run;
    assert.equal((await dispatch(second.id, { message: followUp.message, projectId: design.projectId, revision: 1 })).status, 200);
    const saved = (await (await app.call(`/api/apps/workshop/projects/${design.projectId}`, owner)).json()) as Project;
    assert.equal((saved.cadPlan?.features[1] as { radius: number }).radius, 6);
    const retried = (await start(followUp)).data?.startWorkshopDesign as Run;
    assert.deepEqual([retried.id, retried.created, retried.status, retried.design?.revision], [second.id, false, "complete", 2]);

    // A stale revision, a project without its revision and an unknown run are refused; none starts a task.
    const before = double.calls.filter((call) => call.operation === "task.start").length;
    const stale = await start({ message: "Again", projectId: design.projectId, revision: 1 });
    assert.equal(stale.errors?.[0]?.extensions?.status, 409);
    assert.match((await start({ message: "Again", projectId: design.projectId })).errors?.[0]?.message ?? "", /revision must be supplied together/);
    assert.equal((await read(crypto.randomUUID())).errors?.[0]?.extensions?.status, 404);
    assert.equal(double.calls.filter((call) => call.operation === "task.start").length, before);
    // The dispatch refuses any other task.
    assert.equal((await app.call("/api/internal/workflow-host/v1", owner, { method: "POST", workflowHost: scope(), body: { phase: "interactive", input: { runId: crypto.randomUUID(), task: "workshop-concept", inputs: {} } } })).status, 404);
  } finally {
    await app.dispose();
  }
});

test("concepts: a generated image runs the concept workflow and is kept like an upload", async () => {
  const double = host();
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), installationId, { workflowHost: double.host });
  try {
    const project = (await (await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { example: "holder" } })).json()) as Project;
    const generate = (body: unknown) => app.call(`/api/apps/workshop/projects/${project.id}/concepts/generate`, member, { method: "POST", body, workflowHost: scope() });
    const made = await generate({ revision: 1, prompt: "A sensor in a plant pot", caption: "In the pot" });
    assert.equal(made.status, 201, await made.clone().text());
    const saved = (await made.json()) as Project;
    const [concept] = saved.concepts;
    assert.deepEqual([saved.revision, concept.model, concept.prompt, concept.caption], [2, "gpt-image-1", "A sensor in a plant pot", "In the pot"]);
    const [start, image, collect] = double.calls;
    assert.deepEqual([start.input.workflow, start.input.inputs], ["workshop-concept", { "concept.inputs.projectId": project.id }]);
    assert.deepEqual([image.operation, image.input.runId, image.input.step], ["inference.image", start.input.id, "concept"]);
    assert.equal((collect.input.value as { conceptId: string }).conceptId, concept.id);
    const bucket = await app.bucket("main");
    assert.ok(await bucket.get(`concepts/${concept.key}`));
    assert.equal((await generate({ revision: 1, prompt: "Again" })).status, 409);
  } finally {
    await app.dispose();
  }
});
