import assert from "node:assert/strict";
import test from "node:test";
import { Workflow } from "../src/schema";
import { eventTriggerMatches, loadFixture, readiness } from "../src/engine";

test("generic event workflows validate and derive completion without a provider catalog", () => {
  const workflow = Workflow.parse({ version: "beta", id: "fixture", summary: "Read a connector event", actors: { worker: { kind: "agent" } },
    triggers: [{ on: "event", type: "unknown-provider.changed", input: "read.inputs.event" }],
    steps: [{ id: "read", actor: "worker", instructions: "Read the event.", inputs: { event: { schema: { type: "object" } } }, outputs: { result: { schema: { type: "object" } } } }],
  });
  const fixture = { workflow: "fixture", origin: "synthetic", inputs: { "read.inputs.event": {} }, records: { "read.outputs.result": {} }, expect: { read: "done" } };
  assert.doesNotThrow(() => loadFixture(fixture, workflow));
  assert.throws(() => loadFixture({ ...fixture, expect: { read: "waiting" } }, workflow));
});

test("event source waits for its input and authenticated start receipt before downstream work", () => {
  const workflow = Workflow.parse({
    version: "beta", id: "event-source", summary: "Issue intake", actors: { worker: { kind: "agent" } },
    triggers: [{ on: "event", type: "github.issue", input: "github-webhook.inputs.event" }],
    steps: [
      { id: "github-webhook", source: "event", inputs: { event: { schema: { type: "object" } }, engineerBinding: { schema: { type: "string" } } },
        outputs: { started: { schema: { type: "object", properties: { runId: { type: "number" } }, required: ["runId"] } } } },
      { id: "triage", actor: "worker", instructions: "Classify the issue.",
        inputs: { event: "github-webhook.inputs.event", execution: "github-webhook.outputs.started", executor: "github-webhook.inputs.engineerBinding" },
        outputs: { result: { schema: { type: "object" } } } },
    ],
  });
  assert.deepEqual(readiness(workflow, { inputs: {}, rows: {} }).steps,
    { "github-webhook": "waiting", triage: "waiting" });
  assert.deepEqual(readiness(workflow, { inputs: { "github-webhook.inputs.event": { action: "opened" } }, rows: {} }).steps,
    { "github-webhook": "waiting", triage: "waiting" });
  const inputs = { "github-webhook.inputs.event": { action: "opened" }, "github-webhook.inputs.engineerBinding": "binding-1" };
  assert.deepEqual(readiness(workflow, { inputs, rows: {} }).steps,
    { "github-webhook": "ready", triage: "waiting" });
  assert.deepEqual(readiness(workflow, { inputs, rows: { "github-webhook.outputs.started": { value: { runId: 42 }, complete: true } } }).steps,
    { "github-webhook": "done", triage: "ready" });
  assert.doesNotThrow(() => loadFixture({ workflow: "event-source", origin: "synthetic", inputs,
    records: { "github-webhook.outputs.started": { runId: 42 }, "triage.outputs.result": {} },
    expect: { "github-webhook": "done", triage: "done", run: "complete" } }, workflow));
});

test("event source shape and trigger mapping are explicit while legacy event mappings remain valid", () => {
  const definition = { version: "beta", id: "event-source", summary: "Issue intake", actors: {},
    triggers: [{ on: "event", type: "github.issue", input: "github-webhook.inputs.event" }],
    steps: [{ id: "github-webhook", source: "event", inputs: { event: { schema: { type: "object" } } },
      outputs: { started: { schema: { type: "object" } } } }],
  };
  assert.doesNotThrow(() => Workflow.parse(definition));
  const source = definition.steps[0];
  for (const invalid of [
    { ...source, actor: "worker" },
    { ...source, inputs: { event: { schema: { type: "object" }, default: {} } } },
    { ...source, outputs: { started: { connector: "git-forge", record: "github.run.started" } } },
    { ...source, outputs: { started: { schema: { type: "string" } } } },
    { ...source, outputs: {} },
  ]) assert.equal(Workflow.safeParse({ ...definition, steps: [invalid] }).success, false);
  assert.equal(Workflow.safeParse({ ...definition, triggers: [] }).success, false);
  assert.equal(Workflow.safeParse({ ...definition, triggers: [{ on: "event", type: "github.issue", input: "other.inputs.event" }] }).success, false);
});

test("event trigger matches exact payload fields without provider-specific logic", () => {
  const definition = { version: "beta", id: "event-match", summary: "Issue event", actors: { worker: { kind: "agent" } },
    triggers: [{ on: "event", type: "github.issue", input: "work.inputs.event",
      match: { action: "opened", "repository.private": true, "issue.number": 42 } }],
    steps: [{ id: "work", actor: "worker", instructions: "Read event.", inputs: { event: { schema: { type: "object" } } },
      outputs: { result: { schema: { type: "object" } } } }],
  };
  const workflow = Workflow.parse(definition);
  const trigger = workflow.triggers?.[0];
  assert.ok(trigger?.on === "event");
  assert.equal(eventTriggerMatches(trigger, { action: "opened", repository: { private: true }, issue: { number: 42 } }), true);
  assert.equal(eventTriggerMatches(trigger, { action: "edited", repository: { private: true }, issue: { number: 42 } }), false);
  assert.equal(eventTriggerMatches(trigger, { action: "opened", repository: {}, issue: { number: 42 } }), false);
  assert.equal(eventTriggerMatches(trigger, { action: "opened", repository: { private: true }, issue: { number: "42" } }), false);
  assert.equal(eventTriggerMatches({ ...trigger, match: undefined }, {}), true);
  for (const match of [{ "repository..private": true }, { "issue[0]": 42 }, { action: { any: "opened" } }])
    assert.equal(Workflow.safeParse({ ...definition, triggers: [{ ...definition.triggers[0], match }] }).success, false);
});

test("workflow source and schema references cannot escape the owning package", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readWorkflowPackage } = await import("../src/source");
  const directory = mkdtempSync(join(tmpdir(), "workflow-source-"));
  try {
    const root = join(directory, "package");
    mkdirSync(root);
    writeFileSync(join(directory, "external.yaml"), "version: beta\n");
    symlinkSync(join(directory, "external.yaml"), join(root, "workflow.yaml"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@fixture/workflow", version: "1.0.0", outfitter: { kind: "workflow", definition: "workflow.yaml" } }));
    assert.throws(() => readWorkflowPackage(root), /escapes its package/);
    const { readWorkflowFile } = await import("../src/files");
    const definition = { steps: [{ inputs: { item: { schema: "../external.yaml" } } }] };
    assert.throws(() => readWorkflowFile(join(root, "workflow.yaml"), definition), /escapes its package/);
    assert.throws(() => readWorkflowFile(join(root, "workflow.yaml"), { steps: [{ inputs: { item: { schema: "@unapproved/package/schema" } } }] }), /Undeclared/);
    assert.throws(() => readWorkflowFile(join(root, "workflow.yaml"), { steps: [{ inputs: { item: { schema: "@unapproved/package/../secret" } } }] }), /Invalid/);
    mkdirSync(join(root, "definitions"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas/item.json"), JSON.stringify({ type: "object" }));
    const nested = { steps: [{ inputs: { item: { schema: "../schemas/item.json" } } }] };
    assert.deepEqual(readWorkflowFile(join(root, "definitions/workflow.yaml"), nested, root),
      { steps: [{ inputs: { item: { schema: { type: "object" } } } }] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("external and resident executor bindings reference opaque string run inputs", () => {
  const definition = { version: "beta", id: "bound-execution", summary: "Bound execution", actors: {
    worker: { kind: "external", binding: "work.inputs.executor" },
  }, steps: [{ id: "work", actor: "worker", instructions: "Do the pinned task.",
    inputs: { executor: { schema: { type: "string" } } }, outputs: { result: { schema: { type: "string" } } },
  }] };
  assert.doesNotThrow(() => Workflow.parse(definition));
  assert.doesNotThrow(() => Workflow.parse({ ...definition, actors: { worker: { kind: "resident", binding: "work.inputs.executor" } } }));
  for (const actor of [{ kind: "external" }, { kind: "external", binding: "work.outputs.result" },
    { kind: "external", binding: "work.inputs.missing" }, { kind: "external", binding: "work.inputs.executor.url" },
    { kind: "human", binding: "work.inputs.executor" }])
    assert.equal(Workflow.safeParse({ ...definition, actors: { worker: actor } }).success, false);
  assert.equal(Workflow.safeParse({ ...definition, steps: [{ ...definition.steps[0], inputs: { executor: { schema: { type: "string" }, default: "binding" } } }] }).success, false);
  assert.equal(Workflow.safeParse({ ...definition, steps: [{ ...definition.steps[0], inputs: { executor: { schema: { type: "object" } } } }] }).success, false);
});

test("schedule connection mappings require declared unbound string inputs", () => {
  const source = { version: "beta", id: "source-report", summary: "Read an account", actors: {},
    triggers: [{ on: "schedule", cron: "0 5 * * *", connection: { providers: ["gmail"], inputs: { provider: "read.inputs.provider", label: "read.inputs.label" } } }],
    steps: [{ id: "read", inputs: { provider: { schema: { type: "string" }, default: "gmail" }, label: { schema: { type: "string" }, default: "" } }, outputs: { result: { connector: "database", record: "report.result", schema: { type: "object" } } } }],
  };
  assert.doesNotThrow(() => Workflow.parse(source));
  for (const provider of ["read.inputs.missing", "read.outputs.result", "read.inputs.provider.field"]) {
    const invalid = structuredClone(source); invalid.triggers[0].connection.inputs.provider = provider;
    assert.equal(Workflow.safeParse(invalid).success, false);
  }
});
