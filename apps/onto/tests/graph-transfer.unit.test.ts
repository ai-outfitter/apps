import assert from "node:assert/strict";
import test from "node:test";
import { transferableGraph } from "../src/server/graph-transfer";
import { core, type Graph } from "../src/lib/graph";

test("portable exports retain standalone projects and omit canonical records and incident edges", () => {
  const local = { id: "81000000-0000-4000-8000-000000000001", typeId: core.project, slug: "external-project", title: "External project" };
  const project = { ...local, id: "81000000-0000-4000-8000-000000000002", typeId: core.project, slug: "project", source: { installationId: "planning", type: "project", id: "one" } };
  const graph = { types: [], nodes: [local, project], edges: [{ id: "edge", fromId: local.id, toId: project.id }] } as unknown as Graph;
  const result = transferableGraph(graph);
  assert.deepEqual(result.transfer?.nodes.map(row => row.id), [local.id]);
  assert.deepEqual(result.transfer?.edges, []);
  assert.deepEqual(result.transferOmissions, { nodes: [project.id], edges: ["edge"] });
  assert.match(result.transferLimitations[0], /excludes 1 canonical app records/);
  assert.equal(graph.nodes.length, 2, "full source graph remains intact");
});

test("oversized portable graphs remain downloadable without an invalid transfer", () => {
  const result = transferableGraph({ types: Array(201).fill({}), nodes: [], edges: [] } as unknown as Graph);
  assert.equal(result.transfer, null);
  assert.match(result.transferLimitations[0], /size limit/);
  const empty = transferableGraph({ types: [], nodes: [], edges: [], canEdit: true });
  assert.deepEqual(empty.transfer, { format: "outfitter-wiki-transfer-v1", types: [], nodes: [], edges: [] });
  assert.deepEqual(empty.transferOmissions, { nodes: [], edges: [] });
});


test("an incompatible portable record does not prevent the full graph backup", () => {
  const graph = { types: [], edges: [], nodes: [{ id: "81000000-0000-4000-8000-000000000001", typeId: core.organization, title: "Historical", slug: null }] } as unknown as Graph;
  const result = transferableGraph(graph);
  assert.equal(result.transfer, null);
  assert.match(result.transferLimitations[0], /schema/);
  assert.equal(graph.nodes.length, 1);
});
