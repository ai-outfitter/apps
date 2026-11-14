import assert from "node:assert/strict";
import test from "node:test";
import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  organizationProgressView,
  readOrganizationProgress,
  type ProgressGraph,
} from "../src/server/organization-progress";
const identity = {
  installationId: "planning",
  organizationId: "current-org",
  owner: { kind: "organization" as const, id: "current-org" },
  userId: "reader",
  role: "member",
  canEdit: false,
};
const row = (
  id: string,
  title: string,
  attributes: EntityRecord["attributes"],
): EntityRecord => ({
  ref: { installationId: "wiki", type: "graph-node", id },
  title,
  revision: 1,
  references: [],
  attributes,
});
function fixture() {
  const types = [
    "Organization",
    "Goal",
    "MetricDefinition",
    "Document",
    "pursues",
    "measured_by",
    "documents",
  ].map((name, i) =>
    row(name, name, { name, category: i < 4 ? "node" : "edge" }),
  );
  const node = (
    id: string,
    typeId: string,
    title: string,
    body: Record<string, unknown> = {},
  ) => row(id, title, { typeId, body: JSON.stringify(body) });
  const edge = (id: string, typeId: string, fromId: string, toId: string) =>
    row(id, typeId, { typeId, fromId, toId });
  const organization = row("org-node", "Any organization name", {
    typeId: "Organization",
    properties: { organization_id: "current-org" },
  });
  const goal = node("goal", "Goal", "Active users", {
    kind: "planning-goal",
    target: null,
    unit: "users",
    windowDays: 7,
    staged: true,
  });
  const metric = node("metric", "MetricDefinition", "Daily active users", {
    kind: "planning-kpi",
    metric: "daily-active-users",
  });
  const saleGoal = node("sale-goal", "Goal", "Sell inference", {
    kind: "planning-goal",
    target: 100,
    unit: "USD",
    windowDays: 7,
    staged: true,
  });
  const saleMetric = node(
    "sale-metric",
    "MetricDefinition",
    "Inference sales",
    { kind: "planning-kpi", metric: "inference-sales" },
  );
  const update = (id: string, date: string, sourceUrl?: string) =>
    node(id, "Document", `User feature ${id}`, {
      kind: "delivery-update",
      shippedAt: date,
      summary: "What shipped",
      benefit: "How it helps users",
      staged: true,
      sourceUrl,
    });
  const older = update("older", "2026-10-27T10:00:00Z", "javascript:alert(1)");
  const newer = update(
    "newer",
    "2026-10-28T10:00:00Z",
    "https://example.test/source",
  );
  const foreign = update("foreign", "2026-10-29T10:00:00Z");
  const graph: ProgressGraph = {
    wiki: { installationId: "wiki", hostname: null, slug: "wiki-map", writable: false },
    types,
    nodes: [organization, goal, metric, saleGoal, saleMetric, older],
    edges: [
      edge("e1", "pursues", "org-node", "goal"),
      edge("e2", "measured_by", "goal", "metric"),
      edge("e3", "pursues", "org-node", "sale-goal"),
      edge("e4", "measured_by", "sale-goal", "sale-metric"),
      edge("d1", "documents", "older", "org-node"),
      edge("d2", "documents", "newer", "org-node"),
      edge("d3", "documents", "foreign", "another-org"),
    ],
  };
  return { graph, older, newer, foreign, edge };
}
test("organization progress distinguishes staged targets from disconnected actuals and sorts only linked features", () => {
  const { graph, older, newer, foreign } = fixture();
  const view = organizationProgressView(graph, identity, [
    older,
    newer,
    newer,
    foreign,
  ]);
  assert.deepEqual(
    view.kpis.map((kpi) => ({
      title: kpi.title,
      actual: kpi.actual,
      target: kpi.target,
      staged: kpi.staged,
      window: kpi.windowDays,
    })),
    [
      {
        title: "Daily active users",
        actual: "Not connected",
        target: "X users",
        staged: true,
        window: 7,
      },
      {
        title: "Inference sales",
        actual: "Not connected",
        target: "$100",
        staged: true,
        window: 7,
      },
    ],
  );
  assert.deepEqual(
    view.updates.map((update) => update.id),
    ["newer", "older"],
  );
  assert.equal(view.updates[0].sourceUrl, "https://example.test/source");
  assert.equal(view.updates[1].sourceUrl, undefined);
});
test("organization progress requires unique canonical organization binding and valid typed documents", () => {
  const { graph, older, newer } = fixture();
  assert.deepEqual(
    organizationProgressView(
      graph,
      { ...identity, organizationId: "elsewhere" },
      [older],
    ),
    { kpis: [], updates: [] },
  );
  graph.nodes.push({
    ...graph.nodes[0],
    ref: { ...graph.nodes[0].ref, id: "ambiguous" },
  });
  assert.deepEqual(organizationProgressView(graph, identity, [older]), {
    kpis: [],
    updates: [],
  });
  graph.nodes.pop();
  newer.attributes.body = JSON.stringify({
    kind: "delivery-update",
    shippedAt: "invalid",
    summary: "A",
    benefit: "B",
  });
  older.attributes.typeId = "Goal";
  assert.deepEqual(
    organizationProgressView(graph, identity, [older, newer]).updates,
    [],
  );
});
test("organization progress uses only filtered incident documents and reuses overview nodes", async () => {
  const { graph, newer, foreign } = fixture();
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const host = workflowHost<"interactive">({
    props: {
      workflowHost: {
        async call(operation: string, value: unknown) {
          const input = value as Record<string, unknown>;
          calls.push({ operation, input });
          if (operation === "entities.types")
            return {
              ok: true,
              value: ["graph-type", "graph-node", "graph-edge"].map((type) => ({
                installationId: "wiki",
                template: "wiki-map",
                collection:
                  type === "graph-type"
                    ? "types"
                    : type === "graph-node"
                      ? "nodes"
                      : "edges",
                hostname: null,
                type,
                writable: false,
                title: type,
                description: "",
                schema: {},
              })),
            };
          if (operation === "entities.list")
            return {
              ok: true,
              value: graph.edges.filter(
                (edge) =>
                  edge.attributes.typeId === "documents" &&
                  edge.attributes.toId === "org-node",
              ),
            };
          if (operation === "entities.get" && input.id === "newer")
            return { ok: true, value: newer };
          if (operation === "entities.get" && input.id === "foreign")
            return { ok: true, value: foreign };
          return { ok: false, status: 403, message: "Outside scope" };
        },
      },
    },
  });
  const view = await readOrganizationProgress(
    appDataContext(host),
    identity,
    graph,
  );
  assert.deepEqual(
    view.updates.map((update) => update.id),
    ["newer", "older"],
  );
  const lists = calls.filter((call) => call.operation === "entities.list");
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].input.filter, {
    typeId: "documents",
    toId: "org-node",
    archived: false,
  });
  assert.deepEqual(
    calls
      .filter((call) => call.operation === "entities.get")
      .map((call) => call.input.id),
    ["newer"],
  );
});

test("future and impossible delivery timestamps are not shown as shipped", () => {
  const { graph, newer } = fixture();
  for (const shippedAt of ["2099-10-29T12:00:00Z", "2026-02-30T12:00:00Z"]) {
    const record = structuredClone(newer);
    record.attributes.body = JSON.stringify({
      ...JSON.parse(String(record.attributes.body)),
      shippedAt,
    });
    assert.equal(
      organizationProgressView(
        graph,
        identity,
        [record],
        new Date("2026-10-29T23:00:00Z"),
      ).updates.length,
      0,
    );
  }
});
