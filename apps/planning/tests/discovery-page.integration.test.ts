import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  demoDiscoveryPage,
  discoveryView,
  loadDiscoveryPage,
  readDiscoveryPage,
} from "../src/server/discovery-page";
const record = (
  id: string,
  title: string,
  attributes: EntityRecord["attributes"],
): EntityRecord => ({
  ref: { installationId: "wiki", type: "graph-node", id },
  title,
  revision: 2,
  references: [],
  attributes,
});
const problem = record("problem", "A user problem", {
  summary: "What is missing",
  typeId: "problem-type",
});
const segment = record("segment", "Team", { typeId: "segment-type" });
const unrelated = record("unrelated", "Other context", {
  typeId: "segment-type",
});
const data = {
  wiki: {
    installationId: "wiki",
    hostname: "wiki.example.test",
    slug: "wiki-map",
    writable: false,
  },
  records: [problem],
  graph: {
    nodes: [problem, segment, unrelated],
    types: [
      record("problem-type", "Problem", { name: "Problem" }),
      record("segment-type", "Customer segment", { name: "CustomerSegment" }),
    ],
    edges: [
      record("edge", "Affects", {
        fromId: "problem",
        toId: "segment",
        typeId: "affects",
      }),
    ],
  },
};
test("Discovery server model resolves summary links and excludes unrelated graph nodes", () => {
  const page = discoveryView(
    data,
    "opportunities",
    new URL("https://planning.example.test/opportunities/problem"),
    "problem",
  );
  assert.equal(page.records[0].summary, "What is missing");
  assert.equal(page.records[0].href, "/opportunities/problem");
  assert.deepEqual(page.records[0].related, [
    {
      id: "segment",
      title: "Team",
      kind: "Customer segment",
      href: "/customer-segments/segment",
    },
  ]);
  assert.deepEqual(
    page.graph?.graph.nodes.map((row) => row.ref.id),
    ["problem", "segment"],
  );
});
test("Discovery list has no client graph payload; detail missing states and demo are server-derived", () => {
  assert.equal(
    discoveryView(
      data,
      "opportunities",
      new URL("https://planning.example.test/opportunities"),
    ).graph,
    null,
  );
  const missing = discoveryView(
    data,
    "opportunities",
    new URL("https://planning.example.test/"),
    "missing",
  );
  assert.equal(missing.records.length, 0);
  assert.equal(missing.graph, null);
  const demo = demoDiscoveryPage(
    "customer-segments",
    new URL("https://planning.example.test/"),
  );
  assert.equal(demo.records[0].title, "Small project teams");
  assert.equal(demo.wiki.writable, false);
});

test("Discovery route loader preserves missing and unauthenticated response statuses", async () => {
  const context = {
    request: new Request("https://planning.example.test/opportunities/missing"),
    locals: {},
    url: new URL("https://planning.example.test/opportunities/missing"),
  };
  const missing = await loadDiscoveryPage(
    context,
    "opportunities",
    true,
    "missing",
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.page?.records.length, 0);
  const denied = await loadDiscoveryPage(context, "opportunities", false);
  assert.equal(denied.status, 401);
  assert.equal(denied.page, undefined);
  assert.match(denied.error, /do not have access/);
});

test("Discovery scoped collections select relevant records and deduplicate neighborhood reads", async () => {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const graph: Record<string, EntityRecord[]> = {
    "graph-type": data.graph.types.map((row) => ({
      ...row,
      attributes: { ...row.attributes, category: "node" },
    })),
    "graph-node": data.graph.nodes,
    "graph-edge": data.graph.edges,
  };
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
                template: "onto",
                collection:
                  type === "graph-type"
                    ? "types"
                    : type === "graph-node"
                      ? "nodes"
                      : "edges",
                hostname: "wiki.example.test",
                type,
                writable: false,
                title: type,
                description: "",
                schema: {},
              })).filter((type) => !input.template || type.template === input.template),
            };
          if (input.installationId !== "wiki")
            return { ok: false, status: 403, message: "Outside scope" };
          const rows = graph[String(input.type)] ?? [];
          if (operation === "entities.get") {
            const found = rows.find((row) => row.ref.id === input.id);
            return found
              ? { ok: true, value: found }
              : { ok: false, status: 404, message: "Missing" };
          }
          if (operation === "entities.list")
            return {
              ok: true,
              value: rows.filter((row) =>
                Object.entries(input.filter as Record<string, unknown>).every(
                  ([key, expected]) =>
                    key === "nodeId"
                      ? row.attributes.fromId === expected ||
                        row.attributes.toId === expected
                      : key === "archived"
                        ? !!row.attributes.archived === expected
                        : row.attributes[key] === expected,
                ),
              ),
            };
          return { ok: false, status: 403, message: "Outside scope" };
        },
      },
    },
  });
  const page = await readDiscoveryPage(
    host,
    "opportunities",
    new URL("https://planning.example.test/opportunities"),
  );
  assert.equal(page.records[0].title, "A user problem");
  assert.equal(page.records[0].related[0].title, "Team");
  assert.deepEqual(
    calls.filter((call) => call.operation === "entities.types").map((call) => call.input),
    [{ template: "onto", requireTypes: true }, { template: "wiki-map" }],
  );
  const lists = calls.filter((call) => call.operation === "entities.list");
  assert.deepEqual(
    lists.map((call) => call.input.filter),
    [
      { name: "Problem", category: "node", archived: false },
      { typeId: "problem-type", archived: false },
      { nodeId: "problem", archived: false },
    ],
  );
  assert(lists.every((call) => Array.isArray(call.input.select)));
  assert(!calls.some((call) => call.input.id === "unrelated"));
  assert.equal(
    calls.filter(
      (call) =>
        call.operation === "entities.get" && call.input.id === "segment",
    ).length,
    1,
  );
});
