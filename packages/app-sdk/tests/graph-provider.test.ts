import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverGraphProviders,
  graphProviderDescriptor,
  qualifyGraphReference,
  readGraphProvider,
  resolveGraphProvider,
  type GraphProvider,
} from "../src/graph-provider";
import type { WorkflowHost } from "../src/workflow-host";

const descriptor = graphProviderDescriptor.parse({
  version: 1,
  contracts: [{ id: "outfitter.graph", version: 1 }],
  capabilities: ["graphql.read"],
  types: [{ name: "Project", kind: "record" }],
  queryAction: "graph.graphql",
});
const required = {
  contract: { id: "outfitter.graph", version: 1 },
  capabilities: ["graphql.read"],
};
const provider: GraphProvider = { ...descriptor, installationId: "graph-a" };
function fixture(ids = ["graph-a"]) {
  const calls: Record<string, unknown>[] = [];
  let result: unknown = {
    data: { projects: { nodes: [], pageInfo: { hasNextPage: false } } },
  };
  let refusal: number | undefined;
  const host = {
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, ...input });
      if (operation === "actions.list")
        return ids
          .filter((id) => !input.installationId || id === input.installationId)
          .map((installationId) => ({
            installationId,
            actions: [
              { name: "graph.describe", access: "read", permitted: true },
              { name: "graph.graphql", access: "read", permitted: true },
            ],
          }));
      if (input.action === "graph.describe") return descriptor;
      if (refusal) throw new Response("Source refused", { status: refusal });
      return result;
    },
  } as unknown as WorkflowHost<"interactive">;
  return {
    host,
    calls,
    result: (value: unknown) => {
      result = value;
    },
    refuse: (status: number) => {
      refusal = status;
    },
  };
}

for (const layout of ["onto", "minimal-app", "github-connector"])
  test(`${layout} can describe a graph provider without Wiki ontology or app-name assumptions`, async () => {
    const { host } = fixture([layout]);
    const found = await resolveGraphProvider(host, required);
    assert.equal(found.installationId, layout);
  });

test("ambiguous discovery requires explicit binding and never picks the first provider", async () => {
  const { host, calls } = fixture(["one", "two"]);
  await assert.rejects(
    resolveGraphProvider(host, required),
    (error) => error instanceof Response && error.status === 409,
  );
  assert.equal(
    (await resolveGraphProvider(host, required, { installationId: "two" }))
      .installationId,
    "two",
  );
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "actions.list" && call.installationId === "two",
    ),
  );
});

test("incompatible versions and missing bindings fail closed", async () => {
  const { host } = fixture();
  await assert.rejects(
    resolveGraphProvider(host, {
      contract: { id: "outfitter.graph", version: 2 },
    }),
    (error) => error instanceof Response && error.status === 409,
  );
  await assert.rejects(
    resolveGraphProvider(host, required, { installationId: "missing" }),
    (error) => error instanceof Response && error.status === 409,
  );
});

test("discovery is bounded", async () => {
  const { host } = fixture(Array.from({ length: 33 }, (_, i) => `graph-${i}`));
  await assert.rejects(
    discoverGraphProviders(host),
    (error) => error instanceof Response && error.status === 413,
  );
});

test("reads preserve pageInfo and re-enter scoped authorization on every call", async () => {
  const f = fixture();
  f.result({
    data: {
      projects: {
        nodes: [{ id: "project" }],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      },
    },
  });
  assert.equal(
    (
      await readGraphProvider(f.host, provider, {
        query:
          "{ projects { nodes { id } pageInfo { hasNextPage endCursor } } }",
      })
    ).state,
    "complete",
  );
  f.refuse(403);
  const refused = await readGraphProvider(f.host, provider, {
    query: "{ projects { nodes { id } } }",
  });
  assert.equal(refused.state, "unauthorized");
  assert.equal(refused.result, null);
  assert.equal(
    f.calls.filter((call) => call.operation === "actions.call").length,
    2,
  );
});

test("truncation and field errors are partial, never complete empty activity", async () => {
  const f = fixture();
  f.result({ data: { projects: [] }, extensions: { truncated: true } });
  assert.equal(
    (await readGraphProvider(f.host, provider, { query: "{ projects }" }))
      .state,
    "partial",
  );
  f.result({ data: null, errors: [{ message: "Repository unavailable" }] });
  assert.equal(
    (await readGraphProvider(f.host, provider, { query: "{ projects }" }))
      .state,
    "partial",
  );
  f.result({
    data: { secret: "discard" },
    errors: [{ message: "Denied", extensions: { status: 403 } }],
  });
  assert.equal(
    (await readGraphProvider(f.host, provider, { query: "{ projects }" }))
      .result,
    null,
  );
});

test("unavailable providers remain explicit and caller input failures still throw", async () => {
  const f = fixture();
  f.refuse(503);
  assert.equal(
    (await readGraphProvider(f.host, provider, { query: "{ projects }" }))
      .state,
    "unavailable",
  );
  f.refuse(400);
  await assert.rejects(
    readGraphProvider(f.host, provider, { query: "{ projects }" }),
    (error) => error instanceof Response && error.status === 400,
  );
});

test("provider response budgets are enforced and references require explicit deployment qualification", async () => {
  const f = fixture();
  f.result({ data: { text: "x".repeat(9000) } });
  assert.equal(
    (
      await readGraphProvider(f.host, provider, {
        query: "{ projects }",
        maxBytes: 8192,
      })
    ).state,
    "unavailable",
  );
  assert.deepEqual(
    qualifyGraphReference("deployment-a", {
      installationId: "graph-a",
      type: "Project",
      id: "one",
    }),
    {
      deploymentId: "deployment-a",
      installationId: "graph-a",
      type: "Project",
      id: "one",
    },
  );
});

test("source capture requires pagination proof and rejects nested partial results", async () => {
  const { graphSourceCompleteness } = await import("../src/graph-provider");
  assert.equal(graphSourceCompleteness({ data: null }).complete, false);
  assert.equal(
    graphSourceCompleteness({ data: { things: { nodes: [{ id: "one" }] } } })
      .complete,
    false,
  );
  assert.equal(
    graphSourceCompleteness({
      data: {
        things: { nodes: [{ id: "one" }], pageInfo: { hasNextPage: false } },
      },
    }).complete,
    true,
  );
  assert.equal(
    graphSourceCompleteness({
      data: { things: { nodes: [], pageInfo: { hasNextPage: true } } },
    }).complete,
    false,
  );
  assert.equal(
    graphSourceCompleteness({
      data: {
        things: {
          nodes: [{ children: { nodes: [{ id: "two" }] } }],
          pageInfo: { hasNextPage: false },
        },
      },
    }).complete,
    false,
  );
  assert.equal(
    graphSourceCompleteness({
      data: {
        things: { nodes: [], pageInfo: { hasNextPage: false } },
        nested: { complete: false },
      },
    }).complete,
    false,
  );
  assert.equal(
    graphSourceCompleteness({ data: { records: [{ id: "one" }] } }).complete,
    false,
  );
  assert.equal(
    graphSourceCompleteness({
      data: { records: [{ id: "one" }] },
      extensions: { complete: true },
    }).complete,
    true,
  );
  assert.equal(
    graphSourceCompleteness(
      { data: { records: [{ id: "one" }] } },
      { boundedSelection: true },
    ).complete,
    true,
  );
  assert.equal(
    graphSourceCompleteness({
      data: { labels: ["one", "two"], counts: [1, 2] },
    }).complete,
    true,
  );
  assert.equal(
    graphSourceCompleteness({
      data: { records: [{ id: "one", nested: { truncated: true } }] },
      extensions: { complete: true },
    }).complete,
    false,
  );
});

test("an explicit binding cannot select a different provider when a host returns a broader listing", async () => {
  const f = fixture(["foreign"]);
  const host = {
    call: async (name: string, input: unknown) =>
      f.host.call(name as never, {} as never),
  } as unknown as WorkflowHost<"interactive">;
  await assert.rejects(
    resolveGraphProvider(host, required, { installationId: "wanted" }),
    (e) => e instanceof Response && e.status === 409,
  );
  assert.equal(f.calls.filter((c) => c.operation === "actions.call").length, 0);
});
test("revocation while a provider reads discards returned private data", async () => {
  let revoked = false;
  const host = {
    call: async (name: string) => {
      if (name === "actions.call") {
        revoked = true;
        return { data: { secret: "must not escape" } };
      }
      return [
        {
          installationId: provider.installationId,
          actions: [
            { name: "graph.graphql", access: "read", permitted: !revoked },
          ],
        },
      ];
    },
  } as unknown as WorkflowHost<"interactive">;
  const result = await readGraphProvider(host, provider, {
    query: "{ secret }",
  });
  assert.equal(result.state, "unauthorized");
  assert.equal(result.result, null);
});
test("malformed provider data is unavailable rather than complete empty data", async () => {
  const f = fixture();
  f.result({ data: 7 });
  const result = await readGraphProvider(f.host, provider, {
    query: "{ projects }",
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.result, null);
});

test("a template narrows the listing so only that package is described, and grants nothing", async () => {
  const { host, calls } = fixture(["wiki", "onto", "planning"]);
  const listed = host.call.bind(host) as (
    operation: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  const narrowing = {
    call: async (operation: string, input: Record<string, unknown>) => {
      const answer = await listed(operation, input);
      return operation === "actions.list" && input.template
        ? (answer as { installationId: string }[]).filter(
            (row) => row.installationId === "wiki",
          )
        : answer;
    },
  } as unknown as WorkflowHost<"interactive">;
  const found = await discoverGraphProviders(narrowing, { template: "wiki" });
  assert.deepEqual(
    found.map((row) => row.installationId),
    ["wiki"],
  );
  assert.deepEqual(
    calls.filter((call) => call.action === "graph.describe").length,
    1,
  );
  assert.equal(calls[0].template, "wiki");
  await assert.rejects(discoverGraphProviders(host, { template: "Not A Slug" }));
});
