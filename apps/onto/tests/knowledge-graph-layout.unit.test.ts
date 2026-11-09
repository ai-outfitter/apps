import assert from "node:assert/strict";
import test from "node:test";
import { layoutKnowledgeGraph } from "@ai-outfitter/ui/knowledge-graph/layout";
import {
  core,
  type Graph,
  type GraphNode,
  type GraphEdge,
} from "../src/lib/graph";
const node = (id: string): GraphNode => ({
  id,
  typeId: core.entity,
  title: id,
  slug: id,
  summary: "",
  body: "",
  website: null,
  properties: {},
  source: null,
  archived: false,
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
});
const edge = (
  id: string,
  fromId: string,
  toId: string,
  typeId = core.uses,
): GraphEdge => ({
  id,
  fromId,
  toId,
  typeId,
  title: "",
  body: "",
  properties: {},
  archived: false,
  revision: 1,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
});
type Layout = Awaited<ReturnType<typeof layoutKnowledgeGraph>>;
function checkBoxes(result: Layout) {
  const boxes = [
    ...(result.layout.children ?? []),
    ...(result.layout.edges ?? []).flatMap((edge) => edge.labels ?? []),
  ].map((box) => ({
    id: box.id,
    x: box.x ?? 0,
    y: box.y ?? 0,
    width: box.width ?? 0,
    height: box.height ?? 0,
  }));
  for (let i = 0; i < boxes.length; i++)
    for (const b of boxes.slice(i + 1)) {
      const a = boxes[i];
      const overlap =
        a.x < b.x + b.width - 0.1 &&
        b.x < a.x + a.width - 0.1 &&
        a.y < b.y + b.height - 0.1 &&
        b.y < a.y + a.height - 0.1;
      assert.equal(overlap, false, `overlapping boxes ${a.id} / ${b.id}`);
    }
}
function checkGeometry(result: Layout) {
  checkBoxes(result);
  for (const edge of result.layout.edges ?? [])
    for (const section of edge.sections ?? []) {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      for (let i = 1; i < points.length; i++)
        assert.ok(
          points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
          "all segments are orthogonal",
        );
    }
}
test("shared predicates group without losing relationships, while labels and nodes stay apart", async () => {
  const graph: Graph = {
    nodes: ["a", "b", "c", "d", "e"].map(node),
    edges: [
      edge("ab", "a", "b"),
      edge("ac", "a", "c"),
      edge("bd", "b", "d", core.addresses),
      edge("cd", "c", "d", core.addresses),
      edge("ed", "e", "d", core.experiences),
    ],
    types: [],
    canEdit: false,
  };
  const result = await layoutKnowledgeGraph(graph, graph);
  assert.equal(result.groups.size, 1);
  assert.deepEqual(
    [...result.groups.values()][0].edges.map((e) => e.id),
    ["ab", "ac"],
  );
  assert.deepEqual(
    new Set([...result.edgeRecords.values()].flat()),
    new Set(graph.edges.map((e) => e.id)),
  );
  checkGeometry(result);
});
test("the same renderer lays out a cycle and independent branch without domain rules", async () => {
  const graph: Graph = {
    nodes: ["one", "two", "three", "four"].map(node),
    edges: [
      edge("12", "one", "two"),
      edge("23", "two", "three"),
      edge("31", "three", "one"),
      edge("24", "two", "four"),
    ],
    types: [],
    canEdit: false,
  };
  checkGeometry(await layoutKnowledgeGraph(graph, graph));
});
