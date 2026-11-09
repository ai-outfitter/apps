import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ontoClient,
  resolveOnto,
  stableGraphId,
  typeSegment,
  defaultWiki,
} from "../src/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
const descriptor = {
  version: 1 as const,
  contracts: [{ id: "outfitter.onto", version: 1 }],
  capabilities: ["query"],
  types: [],
  queryAction: "graph.graphql" as const,
};
test("Onto requires its own contract and honors explicit provider bindings", async () => {
  const calls: Array<[string, any]> = [];
  const host = {
    call: async (name: string, input: any) => {
      calls.push([name, input]);
      if (name === "actions.list")
        return [
          {
            installationId: input.installationId ?? "onto",
            actions: [
              { name: "graph.describe", access: "read", permitted: true },
            ],
          },
        ];
      return descriptor;
    },
  } as unknown as WorkflowHost<"interactive">;
  assert.equal(
    (await resolveOnto(host, { installationId: "bound" })).installationId,
    "bound",
  );
  assert.deepEqual(calls[0], ["actions.list", { installationId: "bound" }]);
  assert.throws(
    () =>
      ontoClient(host, {
        ...descriptor,
        installationId: "other",
        contracts: [{ id: "other", version: 1 }],
      }),
    (error: any) => error.status === 409,
  );
});
test("graph IDs and routes stay stable", async () => {
  assert.equal(await stableGraphId("wiki-link-v1", "installation", "type", "from", "to"), await stableGraphId("wiki-link-v1", "installation", "type", "from", "to"));
  assert.deepEqual(["Person", "Company", "Status", "KnowledgeGraph"].map(typeSegment), ["people", "companies", "statuses", "knowledge-graphs"]);
});
test("discovery finds one writable Wiki", async () => {
  const host = {
    call: async (name: string) => {
      assert.equal(name, "entities.types");
      return ["graph-type", "graph-node", "graph-edge"].map((type) => ({
        type,
        installationId: "wiki",
        writable: true,
        slug: "notes",
        hostname: "notes.example",
      }));
    },
  } as unknown as WorkflowHost<"interactive">;
  assert.deepEqual(await defaultWiki(host), { installationId: "wiki", hostname: "notes.example", slug: "notes", writable: true });
});
test("Onto client reads re-enter scoped transport on every invocation", async () => {
  const calls: any[] = [];
  const host = {
    call: async (name: string, input: any) => {
      calls.push({ name, input });
      if (name === "actions.list")
        return [
          {
            installationId: "onto",
            actions: [
              { name: "graph.graphql", access: "read", permitted: true },
            ],
          },
        ];
      return { data: { title: "Current" } };
    },
  } as unknown as WorkflowHost<"interactive">;
  const client = ontoClient(host, { ...descriptor, installationId: "onto" });
  const input = { query: "query { title }" };
  assert.equal((await client.read(input)).state, "complete");
  assert.equal((await client.read(input)).state, "complete");
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => call.name === "actions.list").length, 2);
  assert.equal(calls[0].input.installationId, "onto");
  assert.equal(calls[0].input.readOnly, true);
  assert.equal(calls[0].input.action, "graph.graphql");
});
