import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWiki,
  readWikiGraph,
  wikiAdapter,
  type WikiGraph,
} from "../src/graph-client";
import { workflowHost, type WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { appDataContext } from "@ai-outfitter/app-sdk/database";

const providers = (installationId = "wiki", writable = true) =>
  ["graph-type", "graph-node", "graph-edge"].map((type) => ({
    installationId,
    hostname: "wiki.example",
    type,
    writable,
    title: type,
    description: "",
    schema: {},
  }));

test("Wiki discovery coalesces within a dispatch but rechecks a new host's permissions", async () => {
  let calls = 0;
  let writable = true;
  const stub: WorkflowHostStub = {
    async call(operation, input) {
      assert.equal(operation, "entities.types");
      assert.deepEqual(input, { template: "wiki-map" });
      calls++;
      return { ok: true, value: providers("wiki", writable) };
    },
  };
  const host = workflowHost<"interactive">({ props: { workflowHost: stub } });
  const [first, parallel] = await Promise.all([
    defaultWiki(host),
    defaultWiki(host),
  ]);
  assert.deepEqual(first, parallel);
  assert.equal(first.writable, true);
  await defaultWiki(host);
  assert.equal(calls, 1);
  writable = false;
  const nextRequest = workflowHost<"interactive">({
    props: { workflowHost: stub },
  });
  assert.equal((await defaultWiki(nextRequest)).writable, false);
  assert.equal(calls, 2);
});

test("failed Wiki discovery is retryable and cannot reuse another owner's Wiki", async () => {
  let fail = true;
  const host = workflowHost<"interactive">({
    props: {
      workflowHost: {
        async call() {
          if (fail)
            return { ok: false, status: 503, message: "Temporary failure" };
          return { ok: true, value: providers() };
        },
      },
    },
  });
  await assert.rejects(
    defaultWiki(host),
    (error: unknown) => error instanceof Response && error.status === 503,
  );
  fail = false;
  assert.equal((await defaultWiki(host)).installationId, "wiki");
  const otherOwner = workflowHost<"interactive">({
    props: {
      workflowHost: {
        async call() {
          return { ok: true, value: providers("other-wiki") };
        },
      },
    },
  });
  assert.equal((await defaultWiki(otherOwner)).installationId, "other-wiki");
});

test("Wiki graph reads use one action and do not cache records", async () => {
  let title = "Original";
  let calls = 0;
  const host = workflowHost<"interactive">({ props: { workflowHost: {
    async call(operation: string) {
      if (operation === "entities.types") return { ok: true, value: providers() };
      assert.equal(operation, "actions.call"); calls++;
      return { ok: true, value: { version: 1, installationId: "wiki", types: [], edges: [],
        nodes: [{id: "node", typeId: "type", title, revision: 1}],
        selection: null, truncated: false, missingTypes: [] } };
    },
  } } });
  assert.equal((await readWikiGraph(host)).nodes[0].title, "Original");
  title = "Updated";
  assert.equal((await readWikiGraph(host)).nodes[0].title, "Updated");
  assert.equal(calls, 2);
});

test("Wiki adapter creates types before nodes and edges and preserves stable identities on retries", async () => {
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  const records = new Map<string, EntityRecord>();
  const order: string[] = [];
  const stub: WorkflowHostStub = {
    async call(operation: string, value: unknown) {
      const input = value as {
        type: string;
        id: string;
        attributes: EntityRecord["attributes"] & { id: string };
      };
      if (operation === "entities.get") {
        const record = records.get(input.id);
        return record
          ? { ok: true, value: record }
          : { ok: false, status: 404, message: "Missing" };
      }
      assert.equal(operation, "entities.create");
      const id = input.attributes.id;
      order.push(input.type);
      const record: EntityRecord = {
        ref: { installationId: "wiki", type: input.type, id },
        revision: 1,
        title: "Example",
        attributes: input.attributes,
        references: [],
      };
      records.set(id, record);
      return { ok: true, value: record };
    },
  };
  const host = workflowHost<"interactive">({ props: { workflowHost: stub } });
  const graph: WikiGraph = {
    types: [
      {
        id: ids[0],
        category: "node",
        name: "Thing",
        title: "Thing",
        body: "A generic thing",
        properties: [],
        archived: false,
      },
      {
        id: ids[1],
        category: "edge",
        name: "relates",
        title: "Relates",
        body: "A generic link",
        properties: [],
        archived: false,
      },
    ],
    nodes: [ids[2], ids[3]].map((id, index) => ({
      id,
      typeId: ids[0],
      title: `Thing ${index}`,
      body: "",
      summary: "",
      website: null,
      properties: {},
      archived: false,
    })),
    edges: [
      {
        id: ids[4],
        typeId: ids[1],
        fromId: ids[2],
        toId: ids[3],
        title: "",
        body: "",
        properties: {},
        archived: false,
      },
    ],
  };
  const adapter = wikiAdapter(host, "wiki");
  assert.deepEqual(await adapter.setup(graph), { created: 5, existing: 0 });
  assert.deepEqual(order, [
    "graph-type",
    "graph-type",
    "graph-node",
    "graph-node",
    "graph-edge",
  ]);
  records.get(ids[2])!.attributes.body = "Authored later";
  assert.deepEqual(await adapter.setup(graph), { created: 0, existing: 5 });
  assert.equal(records.get(ids[2])!.attributes.body, "Authored later");
  records.get(ids[4])!.attributes.toId = ids[2];
  await assert.rejects(
    adapter.setup(graph),
    (error: unknown) => error instanceof Response && error.status === 409,
  );
});

test("Wiki setup preserves a meaningful conflict when a name is already taken", async () => {
  const stub: WorkflowHostStub = {
    async call(operation) {
      return {
        ok: false,
        status: operation === "entities.create" ? 409 : 404,
        message: "Conflict",
      };
    },
  };
  const adapter = wikiAdapter(
    workflowHost<"interactive">({ props: { workflowHost: stub } }),
    "wiki",
  );
  await assert.rejects(
    adapter.setup({
      types: [
        {
          id: crypto.randomUUID(),
          category: "node",
          name: "Taken",
          title: "Taken",
          body: "Already exists",
          properties: [],
          archived: false,
        },
      ],
      nodes: [],
      edges: [],
    }),
    (error: unknown) => error instanceof Response && error.status === 409,
  );
});

test("archived metadata options pass through the canonical graph action", async () => {
  const host = workflowHost<"interactive">({ props: { workflowHost: {
    async call(operation: string, value: unknown) {
      if (operation === "entities.types") return { ok: true, value: providers() };
      assert.equal(operation, "actions.call");
      const { input } = value as { input: { includeArchivedTypes?: boolean } };
      return { ok: true, value: { version: 1, installationId: "wiki", nodes: [], edges: [],
        types: (input.includeArchivedTypes ? [false, true] : [false]).map((archived, index) => ({
          id: `type-${index}`, revision: 1, name: `Type${index}`, category: "node", archived,
        })), selection: null, truncated: false, missingTypes: [] } };
    },
  } } });
  assert.equal((await readWikiGraph(host)).types.length, 1);
  const metadata = await readWikiGraph(host, { includeArchivedTypes: true });
  assert.equal(metadata.types.length, 2);
  assert.equal(metadata.types[1].attributes.archived, true);
});

test("Wiki and collection helpers share discovery within one dispatch", async () => {
    let calls = 0;
  const host = { async call(operation: string) {
    assert.equal(operation, "entities.types"); calls++;
    return ["graph-type", "graph-node", "graph-edge"].map((type, index) => ({
      installationId: "wiki", type, collection: ["types", "nodes", "edges"][index],
      template: "wiki-map", writable: false,
    }));
  } } as unknown as WorkflowHost<"interactive">;
  await defaultWiki(host);
  await appDataContext(host).apps.installation("wiki");
  assert.equal(calls, 1, "collection reads reuse the already discovered Wiki schemas");
});
