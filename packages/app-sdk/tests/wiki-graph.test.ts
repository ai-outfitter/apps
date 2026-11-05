import assert from "node:assert/strict";
import test from "node:test";
import { readWikiGraph } from "../src/wiki";
import type { WorkflowHost } from "../src/workflow-host";

test("graph reader makes one action call and preserves the selected Wiki identity", async () => {
  const calls: unknown[] = [];
  const host = { call: async (operation: string, input: unknown) => {
    if (operation === "entities.types") return ["graph-type", "graph-node", "graph-edge"].map(type => ({ type, installationId: "wiki", writable: true }));
    calls.push({ operation, input });
    return { version: 1, installationId: "wiki", types: [], nodes: [], edges: [], selection: null, truncated: false, missingTypes: [] };
  } } as unknown as WorkflowHost<"interactive">;
  const result = await readWikiGraph(host);
  assert.equal(result.wiki.installationId, "wiki");
  assert.deepEqual(calls, [{ operation: "actions.call", input: { installationId: "wiki", action: "graph.read", readOnly: true, maxResponseBytes: 8 * 1024 * 1024, input: {} } }]);
  await assert.rejects(readWikiGraph(host, { rootId: crypto.randomUUID() } as never));
  assert.equal(calls.length, 1);
});

test("read records retain legacy content without applying write defaults or limits", async () => {
  const node = { id: "legacy-id", revision: 1, typeId: "legacy-type", title: "a".repeat(200), body: "b".repeat(20001) };
  const host = { call: async (op: string) => op === "entities.types" ? ["graph-type", "graph-node", "graph-edge"].map(type => ({ type, installationId: "wiki", writable: true })) : ({ version: 1, installationId: "wiki", types: [], nodes: [node], edges: [], selection: null, truncated: false, missingTypes: [] }) } as unknown as WorkflowHost<"interactive">;
  assert.deepEqual((await readWikiGraph(host)).snapshot.nodes, [node]);
});

test("raw archived type evidence cannot reactivate an archived type in the entity view", async () => {
  const archived = { id: "type", revision: 3, name: "Role", category: "node", archived: true };
  const source = { installationId: "planning", type: "project", id: "project" };
  const node = { id: "node", typeId: "type", revision: 7, title: "Stored title", source,
    createdBy: "author", updatedBy: "editor", createdAt: 1, updatedAt: 2 };
  const host = { call: async (op: string) => op === "entities.types"
    ? ["graph-type", "graph-node", "graph-edge"].map(type => ({ type, installationId: "wiki", writable: true }))
    : { version: 1, installationId: "wiki", types: [archived], nodes: [node], edges: [], selection: null, truncated: false, missingTypes: [] }
  } as unknown as WorkflowHost<"interactive">;
  const graph = await readWikiGraph(host);
  assert.deepEqual(graph.types, []);
  assert.equal(graph.snapshot.types[0].archived, true);
  assert.equal(graph.nodes[0].attributes.id, node.id);
  assert.deepEqual(graph.nodes[0].references, [source]);
  assert.deepEqual(graph.nodes[0].attributes.provenance, { createdBy: "author", updatedBy: "editor", createdAt: 1, updatedAt: 2 });
  assert.equal((await readWikiGraph(host, { includeArchivedTypes: true })).types.length, 1);
});

test("a partial response cannot be used as a full authority graph", async () => {
  const host = { call: async (op: string) => op === "entities.types"
    ? ["graph-type", "graph-node", "graph-edge"].map(type => ({type,installationId:"wiki",writable:false}))
    : {version:1,installationId:"wiki",types:[],nodes:[],edges:[],selection:null,truncated:true,missingTypes:[]}
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(readWikiGraph(host), error => error instanceof Response && error.status === 409);
});
