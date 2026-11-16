// The launch-video evals' grader on synthetic Onto tables, with no model: a run that stages
// the reference shape (under other names) passes; one that files shots as Documents does not.
import assert from "node:assert/strict";
import test from "node:test";
import { analyze, type Operation } from "../evals/launch-videos/lib/analysis";
import type { Run } from "../evals/launch-videos/lib/run";

const runWith = (operations: Operation[], types: Record<string, unknown>[] = [{ id: "doc-type", name: "Document", category: "node" }]): Run => ({
  prompt: "", answer: "", calls: [], pointAEqualsPointB: false, judge: "luna",
  onto: {
    before: { graph_batches: [], graph_types: types.map(({ id, name }) => ({ id, name })) },
    after: {
      graph_batches: [{ id: "b1", anchors: "[]" }],
      graph_batch_operations: operations.map((operation) => ({ batchId: "b1", state: "staged", operation: JSON.stringify(operation) })),
      graph_types: types, graph_nodes: [], graph_edges: [],
    },
  },
});
const create = (ref: string, type: Operation["type"], attributes: Record<string, unknown>): Operation => ({ operation: "create", ref, type, attributes });

test("the reference shape under other names: a video, a scene with order and length, scene_in → video", () => {
  const ops = [
    create("$video", "graph-type", { name: "LaunchVideo", category: "node", properties: [{ name: "length_seconds", type: "number" }] }),
    create("$scene", "graph-type", { name: "Scene", category: "node", properties: [{ name: "order", type: "number" }, { name: "duration_seconds", type: "number" }] }),
    create("$scene_in", "graph-type", { name: "scene_in", category: "edge", properties: [], ontology: { version: 2, endpoints: { from: ["$scene"], to: ["$video"] } } }),
    create("$v1", "graph-node", { typeId: "$video", title: "Find your spot", properties: { length_seconds: 15 } }),
    ...[1, 2, 3, 4].map((n) => create(`$s${n}`, "graph-node", { typeId: "$scene", title: `Scene beat ${"abcd"[n - 1]}`, properties: { order: n, duration_seconds: 4 } })),
    ...[1, 2, 3, 4].map((n) => create(`$e${n}`, "graph-edge", { typeId: "$scene_in", fromId: `$s${n}`, toId: "$v1" })),
  ];
  const result = analyze(runWith(ops));
  assert.deepEqual(result.shape, { shot: "Scene", storyboard: "LaunchVideo", relationship: "scene_in" });
  assert.equal(result.typedRecords.length, 5);
});

test("the shape found from staged relationships when the edge type is generic", () => {
  const ops = [
    create("$board", "graph-type", { name: "Storyboard", category: "node", properties: [] }),
    create("$shot", "graph-type", { name: "Shot", category: "node", properties: [{ name: "sequence", type: "number" }, { name: "duration_seconds", type: "number" }] }),
    create("$of", "graph-type", { name: "shot_of", category: "edge", properties: [] }),
    create("$b", "graph-node", { typeId: "$board", title: "Find your spot" }),
    create("$s", "graph-node", { typeId: "$shot", title: "Choose a place", properties: { sequence: 1, duration_seconds: 3 } }),
    create("$e", "graph-edge", { typeId: "$of", fromId: "$s", toId: "$b" }),
  ];
  assert.deepEqual(analyze(runWith(ops)).shape, { shot: "Shot", storyboard: "Storyboard", relationship: "shot_of" });
});

test("shots filed as Documents have no shape", () => {
  const ops = [1, 2, 3, 4].map((n) => create(`$d${n}`, "graph-node", { typeId: "doc-type", title: `0${n} — Hook` }));
  const result = analyze(runWith(ops));
  assert.equal(result.shape, null);
  assert.deepEqual(result.shots, []);
  assert.equal(result.documents.length, 4);
});

test("a shot type with no duration does not match", () => {
  const ops = [
    create("$board", "graph-type", { name: "Storyboard", category: "node", properties: [] }),
    create("$shot", "graph-type", { name: "Shot", category: "node", properties: [{ name: "sequence", type: "number" }, { name: "start_seconds", type: "number" }] }),
    create("$of", "graph-type", { name: "shot_of", category: "edge", properties: [], ontology: { version: 2, endpoints: { from: ["$shot"], to: ["$board"] } } }),
  ];
  assert.equal(analyze(runWith(ops)).shape, null);
});
