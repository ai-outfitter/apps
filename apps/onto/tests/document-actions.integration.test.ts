import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { createDocumentActions } from "../src/server/documents/integration";
import {
  processDocumentSchedule,
  processDocumentTask,
} from "../src/server/documents/worker";

async function fixture() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(
    await readFile(
      new URL("../migrations/0013_documents.sql", import.meta.url),
      "utf8",
    ),
  );
  const db: AgentDatabase = {
    query: async (s) =>
      (await client.execute({ sql: s.sql, args: s.params as never[] }))
        .rows as unknown as Record<string, unknown>[],
    batch: async (ss) =>
      client.batch(
        ss.map((s) => ({ sql: s.sql, args: s.params as never[] })),
        "write",
      ),
  };
  const host = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === "task.start")
        return { id: input.id, task: input.task, created: true };
      if (name === "workflow.start")
        return { id: input.id, workflow: input.workflow, created: true };
      if (name === "workflow.collect")
        return { run: "complete", steps: { render: "complete" } };
      if (name === "actions.list")
        return [
          {
            installationId: "graph",
            actions: [
              { name: "graph.describe", access: "read", permitted: true },
              { name: "graph.graphql", access: "read", permitted: true },
            ],
          },
        ];
      if (name === "actions.call" && input.action === "graph.describe")
        return {
          version: 1,
          contracts: [{ id: "outfitter.graph", version: 1 }],
          capabilities: ["graphql.read"],
          types: [],
          queryAction: "graph.graphql",
        };
      if (name === "actions.call" && input.action === "graph.graphql")
        return {
          data: {
            things: { nodes: [{ id: "1" }], pageInfo: { hasNextPage: false } },
          },
        };
      throw new Response("unavailable", { status: 503 });
    },
  } as unknown as WorkflowHost<"interactive">;
  const identity = {
    userId: "u",
    organizationId: "org",
    owner: { kind: "organization", id: "org" },
    installationId: "onto",
    role: "owner",
    canEdit: true,
  } as ActionContext["identity"];
  const context = {
    identity,
    actor: { kind: "member", id: "u" },
    originActor: { kind: "member", id: "u" },
  } as ActionContext;
  return {
    db,
    host,
    context,
    client,
    actions: createDocumentActions({ db: () => db, host: () => host }),
  };
}
test("actions authorize bindings, validate inputs and schedule generation", async (t) => {
  const { db, host, context, client, actions } = await fixture();
  t.after(() => client.close());
  const define = {
    id: "review",
    version: 1,
    definition: {
      sources: [
        {
          provider: "graph",
          config: {
            query: "{ things { nodes { id } pageInfo { hasNextPage } } }",
          },
        },
      ],
    },
  };
  await assert.rejects(
    actions["document.define"].invoke(
      { ...context, identity: { ...context.identity, role: "member" } },
      define,
    ),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  await assert.rejects(
    actions["document.define"].invoke(context, { ...define, owner: "other" }),
    (e: unknown) => e instanceof Response && e.status === 400,
  );
  await actions["document.define"].invoke(context, define);
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "review",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  await assert.rejects(
    processDocumentSchedule(
      db,
      context.identity,
      host as unknown as WorkflowHost<"schedule">,
      "interactive",
      {},
    ),
  );
  const input = {
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    scheduledFor: 1,
    schedule: {
      id: "s",
      workflowId: "document-generation",
      inputs: {},
      connectionId: null,
      resource: null,
    },
  };
  assert.deepEqual(
    await processDocumentSchedule(
      db,
      context.identity,
      host as unknown as WorkflowHost<"schedule">,
      "schedule",
      input,
    ),
    { completed: 1, failed: 0, started: true },
  );
  const revision = (await actions["document.revision"].invoke(context, {
    id: "doc",
    revision: 1,
  })) as { complete: boolean };
  assert.equal(revision.complete, true);
  assert.equal(
    (
      (await actions["document.policy"].invoke(context, {
        id: "doc",
        revision: 1,
        action: "publish",
      })) as { decision: string }
    ).decision,
    "allow",
  );
  await assert.rejects(
    actions["document.revision"].invoke(
      {
        ...context,
        identity: {
          ...context.identity,
          owner: { kind: "organization", id: "other" },
        },
      },
      { id: "doc", revision: 1 },
    ),
  );
});

test("named GraphQL documents use the same action permission and validation", async (t) => {
  const { serveGraphql } = await import("@ai-outfitter/app-sdk/app-graphql");
  const { graphqlSchema } = await import("../src/server/graphql");
  const { documents } = await import("../src/server/documents");
  const { actions, context, client } = await fixture();
  t.after(() => client.close());
  const run = (
    key: keyof typeof documents,
    input: object,
    who: ActionContext = context,
    withActions = true,
  ) =>
    serveGraphql({
      schema: graphqlSchema,
      operation: key === "DocumentLive" ? "query" : "mutation",
      query: String(documents[key].document),
      variables: { input },
      context: { ...who, ...(withActions ? { documentActions: actions } : {}) },
      maxBytes: 65536,
    });
  const definition = {
    id: "review",
    version: 1,
    definition: {
      sources: [
        {
          provider: "graph",
          config: {
            query: "{ things { nodes { id } pageInfo { hasNextPage } } }",
          },
        },
      ],
    },
  };
  const member = {
    ...context,
    identity: { ...context.identity, role: "member" },
  };
  assert.ok((await run("DefineDocument", definition, member)).errors?.length);
  assert.ok(
    (await run("DefineDocument", definition, context, false)).errors?.length,
  );
  assert.ok(
    (await run("DefineDocument", { ...definition, owner: "other" })).errors
      ?.length,
  );
  assert.equal((await run("DefineDocument", definition)).errors, undefined);
  assert.equal(
    (
      await run("CreateDocument", {
        id: "doc",
        definitionId: "review",
        version: 1,
      })
    ).errors,
    undefined,
  );
  const live = await run("DocumentLive", { id: "doc" });
  assert.equal(live.errors, undefined);
  assert.equal(
    (live.data as { documentLive: { complete: boolean } }).documentLive
      .complete,
    true,
  );
});

test("GitHub source scheduled work fails closed without a repository request", async (t) => {
  const { db, context, client, actions } = await fixture();
  t.after(() => client.close());
  await actions["document.define"].invoke(context, {
    id: "github",
    version: 1,
    definition: {
      sources: [
        {
          provider: "github-report",
          config: {
            connectionId: "c",
            repository: "example/repo",
            branch: "main",
            start: "2026-01-01T00:00:00Z",
            end: "2026-01-02T00:00:00Z",
          },
        },
      ],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "github",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  let calls = 0;
  const scheduleHost = {
    call: async () => {
      calls++;
      throw new Error("unexpected host access");
    },
  } as unknown as WorkflowHost<"schedule">;
  const input = {
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    scheduledFor: 1,
    schedule: {
      id: "s",
      workflowId: "document-generation",
      inputs: {},
      connectionId: null,
      resource: null,
    },
  };
  assert.deepEqual(
    await processDocumentSchedule(
      db,
      context.identity,
      scheduleHost,
      "schedule",
      input,
    ),
    { completed: 0, failed: 1, started: false },
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await db.query({ sql: "SELECT state FROM document_jobs WHERE id='job'" })
    )[0].state,
    "retry",
  );
});

test("agent rendering runs in registered scheduled workflow and records its provenance", async (t) => {
  const { db, host, context, client, actions } = await fixture();
  t.after(() => client.close());
  const contract = {
    version: 1,
    identity: "business",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      required: ["title", "markdown"],
      properties: { title: { type: "string" }, markdown: { type: "string" } },
      additionalProperties: false,
    },
    params: { quarter: "Q1" },
    rendering: { mode: "combined", template: "business-review" },
    refresh: "schedule",
    requirements: { evidence: true, seal: true, export: false },
  };
  await actions["document.define"].invoke(context, {
    id: "review",
    version: 1,
    definition: {
      contract,
      sources: [
        {
          provider: "graph",
          config: {
            query: "{ things { nodes { id } pageInfo { hasNextPage } } }",
          },
        },
      ],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "review",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  let inference = 0;
  const wrapper = {
    call: async (name: string, input: unknown) => {
      if (name === "inference.generate") {
        inference++;
        return { output: { title: "Review", markdown: "Captured evidence" } };
      }
      return (host.call as (name: string, input: unknown) => Promise<unknown>)(
        name,
        input,
      );
    },
  } as unknown as WorkflowHost<"schedule">;
  const input = {
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    scheduledFor: 1,
    schedule: {
      id: "s",
      workflowId: "document-generation",
      inputs: {},
      connectionId: null,
      resource: null,
    },
  };
  assert.equal(
    (
      await processDocumentSchedule(
        db,
        context.identity,
        wrapper,
        "schedule",
        input,
      )
    ).completed,
    1,
  );
  assert.equal(inference, 1);
  const r = (await actions["document.revision"].invoke(context, {
    id: "doc",
    revision: 1,
  })) as { payload: { provenance: { workflowRun: string; params: unknown } } };
  assert.equal(r.payload.provenance.workflowRun, input.runId);
  assert.deepEqual(r.payload.provenance.params, { quarter: "Q1" });
  assert.equal(
    (
      (await actions["document.job"].invoke(context, { id: "job" })) as {
        state: string;
      }
    ).state,
    "complete",
  );
});

test("failed current jobs are visible and only an owner may retry", async (t) => {
  const { db, context, client, actions } = await fixture();
  t.after(() => client.close());
  await actions["document.define"].invoke(context, {
    id: "review",
    version: 1,
    definition: {
      sources: [{ provider: "graph", config: { query: "{ thing }" } }],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "review",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  await db.batch([
    {
      sql: "UPDATE document_jobs SET state='failed',attempts=5,error='source unavailable' WHERE id='job'",
    },
  ]);
  const job = (await actions["document.job"].invoke(context, {
    id: "job",
  })) as { state: string; error: string };
  assert.equal(job.state, "failed");
  assert.equal(job.error, "source unavailable");
  await assert.rejects(
    actions["document.retry"].invoke(
      { ...context, identity: { ...context.identity, role: "member" } },
      { id: "job" },
    ),
  );
  const retried = (await actions["document.retry"].invoke(context, {
    id: "job",
  })) as { runId: string };
  assert.ok(retried.runId);
  assert.equal(
    (
      (await actions["document.job"].invoke(context, { id: "job" })) as {
        state: string;
      }
    ).state,
    "queued",
  );
});

test("manual task captures GitHub using the member host and the existing task run", async (t) => {
  const { db, context, client, actions, host } = await fixture();
  t.after(() => client.close());
  await actions["document.define"].invoke(context, {
    id: "gh",
    version: 1,
    definition: {
      sources: [
        {
          provider: "github-report",
          config: {
            connectionId: "c",
            repository: "example/repo",
            branch: "main",
            start: "2026-01-01T00:00:00Z",
            end: "2026-01-02T00:00:00Z",
          },
        },
      ],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "gh",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  const calls: string[] = [];
  const manualHost = {
    call: async (name: string, input: Record<string, unknown>) => {
      calls.push(name);
      if (name === "repository.request")
        return String(input.path).includes("/git/ref/")
          ? { object: { sha: "a".repeat(40) } }
          : [];
      if (name === "workflow.start") throw new Error("task run already exists");
      return (host.call as (name: string, input: unknown) => Promise<unknown>)(
        name,
        input,
      );
    },
  } as unknown as WorkflowHost<"interactive">;
  const input = {
    task: "document-generation",
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    inputs: { jobId: "job" },
  };
  await assert.rejects(
    processDocumentTask(db, context.identity, manualHost, {
      ...input,
      inputs: {},
    }),
  );
  assert.deepEqual(
    await processDocumentTask(db, context.identity, manualHost, input),
    { completed: 1, failed: 0, started: true },
  );
  assert.ok(calls.includes("repository.request"));
  assert.ok(!calls.includes("workflow.start"));
  const revision = (await actions["document.revision"].invoke(context, {
    id: "doc",
    revision: 1,
  })) as { complete: boolean };
  assert.equal(revision.complete, true);
});

test("schedule refresh enqueues one idempotent occurrence and respects editor identity", async (t) => {
  const { db, context, client, actions, host } = await fixture();
  t.after(() => client.close());
  const contract = {
    version: 1,
    identity: "schedule",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      required: ["title", "markdown"],
      properties: { title: { type: "string" }, markdown: { type: "string" } },
      additionalProperties: false,
    },
    params: {},
    rendering: { mode: "template", template: "roadmap" },
    refresh: "schedule",
    requirements: { evidence: true, seal: false, export: false },
  };
  await actions["document.define"].invoke(context, {
    id: "def",
    version: 1,
    definition: {
      contract,
      sources: [
        {
          provider: "graph",
          config: {
            query: "{ things { nodes { id } pageInfo { hasNextPage } } }",
          },
        },
      ],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "def",
    version: 1,
  });
  const input = {
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    scheduledFor: 1,
    schedule: {
      id: "s",
      workflowId: "document-generation",
      inputs: {},
      connectionId: null,
      resource: null,
    },
  };
  await assert.rejects(
    processDocumentSchedule(
      db,
      { ...context.identity, canEdit: false },
      host as unknown as WorkflowHost<"schedule">,
      "schedule",
      input,
    ),
  );
  assert.equal(
    (
      await processDocumentSchedule(
        db,
        context.identity,
        host as unknown as WorkflowHost<"schedule">,
        "schedule",
        input,
      )
    ).completed,
    1,
  );
  await actions["document.create"].invoke(context, {
    id: "another",
    definitionId: "def",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "another",
    jobId: "another-job",
  });
  assert.equal(
    (
      await processDocumentSchedule(
        db,
        context.identity,
        host as unknown as WorkflowHost<"schedule">,
        "schedule",
        input,
      )
    ).started,
    false,
  );
  assert.equal(
    (
      await db.query({
        sql: "SELECT state FROM document_jobs WHERE id='another-job'",
      })
    )[0].state,
    "queued",
  );
});

test("graph sources without pagination proof cannot produce a complete revision", async (t) => {
  const { db, context, client, actions, host } = await fixture();
  t.after(() => client.close());
  await actions["document.define"].invoke(context, {
    id: "def",
    version: 1,
    definition: {
      sources: [
        { provider: "graph", config: { query: "{ things { nodes { id } } }" } },
      ],
    },
  });
  await actions["document.create"].invoke(context, {
    id: "doc",
    definitionId: "def",
    version: 1,
  });
  await actions["document.generate"].invoke(context, {
    id: "doc",
    jobId: "job",
  });
  const partial = {
    call: async (name: string, input: Record<string, unknown>) =>
      name === "actions.call" && input.action === "graph.graphql"
        ? { data: { things: { nodes: [{ id: "1" }] } } }
        : (host.call as (name: string, input: unknown) => Promise<unknown>)(
            name,
            input,
          ),
  } as unknown as WorkflowHost<"schedule">;
  const input = {
    runId: "b10351d9-3485-4b63-9fe9-1ce2b5c37f87",
    scheduledFor: 1,
    schedule: {
      id: "s",
      workflowId: "document-generation",
      inputs: {},
      connectionId: null,
      resource: null,
    },
  };
  assert.equal(
    (
      await processDocumentSchedule(
        db,
        context.identity,
        partial,
        "schedule",
        input,
      )
    ).failed,
    1,
  );
  assert.equal(
    (await db.query({ sql: "SELECT COUNT(*) AS n FROM document_revisions" }))[0]
      .n,
    0,
  );
});

test("policy subject action derives installation and owner and reveals no document content", async (t) => {
  const { db, host, context, actions, client } = await fixture();
  t.after(() => client.close());
  const { putDefinition, createDocument, readLive, enqueue, lease, complete } =
    await import("../src/server/documents/service");
  const { scopeOf } = await import("../src/server/documents/integration");
  const scope = scopeOf(context.identity);
  const source = {
    read: async () => ({ complete: true, provenance: {}, snapshot: {} }),
    verifyCapture: async () => true,
    policy: async (binding: any) => ({ binding, decision: "allow" as const }),
    deliver: async () => ({}),
  };
  await putDefinition(db, scope, "subject", 1, {
    sources: [{ provider: "graph", config: "fixture" }],
    policy: { provider: "governance", config: "rules", required: true },
  });
  await createDocument(db, scope, "subject-doc", "subject", 1);
  const capture = await readLive(db, scope, "subject-doc", source);
  await enqueue(db, scope, "subject-doc", "subject-job");
  await lease(db, scope, "subject-job", "worker", 1, 10);
  const revision = await complete(
    db,
    scope,
    "subject-job",
    "worker",
    2,
    { secret: "private" },
    capture,
  );
  const binding = {
    version: 1 as const,
    producer: { installationId: "onto" },
    owner: { kind: "organization" as const, id: "org" },
    documentId: "subject-doc",
    revision: 1,
    digest: revision.digest,
    action: "seal",
    provider: "governance",
    config: "rules",
  };
  const result = (await actions["document.policy-subject"].invoke(
    context,
    binding,
  )) as { subject: unknown; digest: string };
  assert.equal(result.digest.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  await assert.rejects(
    actions["document.policy-subject"].invoke(context, {
      ...binding,
      producer: { installationId: "spoof" },
    }),
  );
  await assert.rejects(
    actions["document.policy-subject"].invoke(
      {
        ...context,
        identity: {
          ...context.identity,
          owner: { kind: "organization", id: "other" },
        },
      },
      binding,
    ),
  );
});
