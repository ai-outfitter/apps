import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import {
  capturedWithType, measuredValue, measureInput, measurementOfType, measurementType, measurementWindow, metricMeasurements, recordMeasurements,
} from "../src/server/measurements";

const editor: OrganizationIdentity = { userId: "bob", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "planning", role: "owner", canEdit: true };
const member: OrganizationIdentity = { ...editor, role: "member", canEdit: false };
const record = (id: string, attributes: Record<string, unknown>, title = id) => ({ ref: { installationId: "wiki", type: "node", id }, revision: 1, title, attributes, references: [] });
const NOW = Date.parse("2026-11-12T15:00:00Z"); // a Thursday
const STARS = "11111111-1111-4111-8111-111111111111";
const CHECKOUT = "22222222-2222-4222-8222-222222222222";
const BROKEN = "33333333-3333-4333-8333-333333333333";
const CHECKOUT_QUERY = "select count(distinct person_id) as visitors from events where timestamp >= toDateTime('{{windowStart}}') and timestamp < toDateTime('{{windowEnd}}')";

function graph(extra: { nodes?: ReturnType<typeof record>[]; edges?: ReturnType<typeof record>[] } = {}) {
  return {
    wiki: { installationId: "wiki" },
    types: ["MetricDefinition", "Measure", "Measurement", "computes", "measurement_of", "captured_with"].map((name) => record(`t-${name}`, { name })),
    nodes: [
      record("metric-stars", { typeId: "t-MetricDefinition" }, "GitHub stars"),
      record("metric-checkout", { typeId: "t-MetricDefinition" }, "Checkout visitors"),
      record(STARS, { typeId: "t-Measure", slug: "webapp-stars", properties: { connector: "github", operation: "repositories.read", resource: "ai-outfitter/webapp", value: "stars", unit: "stars", interval: "weekly" } }, "webapp stars"),
      record(CHECKOUT, { typeId: "t-Measure", properties: { connector: "posthog", operation: "query.run", resource: "us.posthog.com/projects/4242", input: JSON.stringify({ query: CHECKOUT_QUERY }), value: "rows.0.visitors", unit: "people" } }, "Checkout visitors"),
      record(BROKEN, { typeId: "t-Measure", properties: { connector: "posthog" } }, "Half-written"),
      ...(extra.nodes ?? []),
    ],
    edges: [
      record("c1", { typeId: "t-computes", fromId: STARS, toId: "metric-stars" }),
      record("c2", { typeId: "t-computes", fromId: CHECKOUT, toId: "metric-checkout" }),
      ...(extra.edges ?? []),
    ],
  };
}

type Input = Record<string, any>;
function host(connections = [{ id: "gh", provider: "github", owner: "organization", operations: ["repositories.read"] }, { id: "ph", provider: "posthog", owner: "organization", operations: ["query.run"] }]) {
  const calls: { operation: string; input: Input }[] = [];
  const handlers: Record<string, (input: Input) => unknown> = {
    "workflow.start": (input) => ({ id: input.id }),
    "workflow.collect": () => ({}),
    snapshot: () => ({ connections }),
    "repository.request": () => ({ id: 30 }),
    "connector.execute": (input) => input.operation === "repositories.read" ? { repository: "ai-outfitter/webapp", stars: 128 } : { columns: ["visitors"], rows: [{ visitors: 318 }], truncated: false },
    "actions.call": (input) => {
      if (input.action === "batch.open") return { batch: { id: "batch" } };
      if (input.input.operationName === "StageChanges") return { data: { stageChanges: { id: "batch", state: "open" } } };
      return { data: { submitBatch: { id: "batch", state: "committed" } } };
    },
  };
  const double = { async call(operation: string, input: Input) {
    calls.push({ operation, input });
    const handler = handlers[operation];
    if (!handler) throw new Error(`Unexpected ${operation}`);
    return handler(input);
  } };
  return { calls, host: double as never };
}

test("windows are half-open UTC weeks from Monday or days", () => {
  assert.deepEqual(measurementWindow("weekly", NOW), { start: "2026-11-09T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" });
  assert.deepEqual(measurementWindow("weekly", Date.parse("2026-11-09T00:00:00Z")), { start: "2026-11-09T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" });
  assert.deepEqual(measurementWindow("weekly", Date.parse("2026-11-15T23:59:59Z")).start, "2026-11-09T00:00:00.000Z");
  assert.deepEqual(measurementWindow("daily", NOW), { start: "2026-11-12T00:00:00.000Z", end: "2026-11-13T00:00:00.000Z" });
});

test("inputs get the window's times and values come from a dot path", () => {
  const input = measureInput({ connector: "posthog", operation: "query.run", resource: "r", input: JSON.stringify({ query: CHECKOUT_QUERY }), value: "rows.0.visitors", unit: "", interval: "weekly" },
    { start: "2026-11-09T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" });
  assert.match(String(input.query), /'2026-11-09T00:00:00.000Z'.*'2026-11-16T00:00:00.000Z'/);
  assert.equal(measuredValue({ rows: [{ visitors: 318 }] }, "rows.0.visitors"), 318);
  assert.equal(measuredValue({ stars: "12" }, "stars"), 12);
  assert.throws(() => measuredValue({ rows: [] }, "rows.0.visitors"), /No value/);
  assert.throws(() => measuredValue({ stars: null }, "stars"), /not a number/);
});

test("every Measure is read for its window and staged as one batch that commits by policy", async () => {
  const { calls, host: double } = host();
  const result = await recordMeasurements(double, editor, {}, { readGraph: async () => graph() as never, now: NOW });
  assert.equal(result.measures, 2);
  assert.equal(result.recorded, 2);
  assert.equal(result.state, "committed");
  assert.deepEqual(result.unread.map((item) => item.measure), ["Half-written"]);

  const executed = calls.filter((call) => call.operation === "connector.execute").map((call) => call.input);
  assert.deepEqual(executed.map((input) => [input.connectionId, input.resource, input.operation]), [["gh", "30", "repositories.read"], ["ph", "us.posthog.com/projects/4242", "query.run"]]);
  assert.match(String(executed[1].input.query), /2026-11-09T00:00:00.000Z/);

  const opened = calls.find((call) => call.input.action === "batch.open")!.input.input;
  assert.deepEqual(opened.policy, { kind: "confidence", threshold: 1, version: "planning-measurements-1" });
  const proposals = calls.filter((call) => call.input.input?.operationName === "StageChanges").flatMap((call) => call.input.input.variables.input.proposals);
  const nodes = proposals.filter((p: Input) => p.operation.type === "graph-node").map((p: Input) => p.operation.attributes);
  assert.deepEqual(nodes.map((node: Input) => [node.typeId, node.slug, node.properties.value, node.properties.window_start]), [
    [measurementType, "webapp-stars-2026-11-09", 128, "2026-11-09T00:00:00.000Z"],
    [measurementType, "checkout-visitors-2026-11-09", 318, "2026-11-09T00:00:00.000Z"],
  ]);
  const edges = proposals.filter((p: Input) => p.operation.type === "graph-edge").map((p: Input) => [p.operation.attributes.typeId, p.operation.attributes.toId]);
  assert.deepEqual(edges, [[capturedWithType, STARS], [measurementOfType, "metric-stars"], [capturedWithType, CHECKOUT], [measurementOfType, "metric-checkout"]]);
  assert.ok(proposals.every((p: Input) => p.confidence === 1 && p.evidence.length === 1));
});

test("a recorded window is skipped, a missing connection or failed read records nothing, members cannot record", async () => {
  const done = graph({
    nodes: [record("m1", { typeId: "t-Measurement", properties: { value: 120, window_start: "2026-11-09T00:00:00.000Z" } })],
    edges: [record("w1", { typeId: "t-captured_with", fromId: "m1", toId: STARS })],
  });
  const { calls, host: double } = host([]);
  const result = await recordMeasurements(double, editor, {}, { readGraph: async () => done as never, now: NOW });
  assert.equal(result.skipped, 1);
  assert.equal(result.recorded, 0);
  assert.equal(result.batchId, null);
  assert.match(result.unread.find((item) => item.measure === "Checkout visitors")!.reason, /Connect the organization's posthog/);
  assert.ok(!calls.some((call) => call.operation === "connector.execute"));

  const only = await recordMeasurements(host().host, editor, { measureId: CHECKOUT }, { readGraph: async () => graph() as never, now: NOW });
  assert.equal(only.recorded, 1);
  await assert.rejects(recordMeasurements(host().host, editor, { measureId: "44444444-4444-4444-8444-444444444444" }, { readGraph: async () => graph() as never, now: NOW }),
    (error: unknown) => error instanceof Response && error.status === 404);
  await assert.rejects(recordMeasurements(host().host, member, {}, { readGraph: async () => graph() as never, now: NOW }));
});

test("each metric reads its latest and previous window and the change", () => {
  const reading = (id: string, value: number, start: string, capturedAt = `${start.slice(0, 10)}T06:00:00.000Z`) =>
    record(id, { typeId: "t-Measurement", properties: { value, unit: "stars", window_start: start, window_end: "", captured_at: capturedAt } });
  const of = (id: string, from: string) => record(id, { typeId: "t-measurement_of", fromId: from, toId: "metric-stars" });
  const result = metricMeasurements(graph({
    nodes: [reading("a", 100, "2026-10-26T00:00:00.000Z"), reading("b", 120, "2026-11-02T00:00:00.000Z"), reading("c", 128, "2026-11-09T00:00:00.000Z"),
      reading("c2", 131, "2026-11-09T00:00:00.000Z", "2026-11-12T06:00:00.000Z")],
    edges: [of("e1", "a"), of("e2", "b"), of("e3", "c"), of("e4", "c2")],
  }) as never);
  const stars = result.find((item) => item.metricId === "metric-stars")!;
  assert.equal(stars.latest?.value, 131);
  assert.equal(stars.previous?.value, 120);
  assert.equal(stars.change, 11);
  const checkout = result.find((item) => item.metricId === "metric-checkout")!;
  assert.deepEqual([checkout.latest, checkout.previous, checkout.change], [null, null, null]);
});
