import assert from "node:assert/strict";
import test from "node:test";
import { queryWikiGraph } from "../src/graph-client";
import { workflowHost, type WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";

const providers = ["graph-type", "graph-node", "graph-edge"].map((type) => ({
  installationId: "wiki", hostname: "wiki.example", type, writable: false, title: type, description: "", schema: {},
}));
const result = (installationId: string) => ({ version: 1, installationId, nodes: [], edges: [], types: [], queries: {}, complete: true });

test("queryWikiGraph reads the owner's Wiki through one read-only graph.query action", async () => {
  const calls: unknown[] = [];
  const stub: WorkflowHostStub = {
    async call(operation, input) {
      if (operation === "entities.types") return { ok: true, value: providers };
      calls.push({ operation, input });
      return { ok: true, value: result("wiki") };
    },
  };
  const host = workflowHost<"interactive">({ props: { workflowHost: stub } });
  const input = { queries: [{ name: "projects", entity: "node" as const }] };
  const { wiki, installationId, complete } = await queryWikiGraph(host, input);
  assert.equal(wiki.installationId, "wiki");
  assert.equal(installationId, "wiki");
  assert.equal(complete, true);
  assert.deepEqual(calls, [{ operation: "actions.call", input: { installationId: "wiki", action: "graph.query", input, readOnly: true, maxResponseBytes: 512 * 1024 } }]);
});

test("queryWikiGraph refuses an answer from another installation", async () => {
  const stub: WorkflowHostStub = {
    async call(operation) {
      return operation === "entities.types" ? { ok: true, value: providers } : { ok: true, value: result("other") };
    },
  };
  const host = workflowHost<"interactive">({ props: { workflowHost: stub } });
  await assert.rejects(queryWikiGraph(host, { queries: [{ name: "all", entity: "node" }] }), (error: unknown) => error instanceof Response && error.status === 409);
});
