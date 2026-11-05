import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type InValue } from "@libsql/client";
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from "drizzle-kit/api";
import { z } from "zod";
import { actionAgent } from "../src/action-agent";
import { defineAction } from "../src/actions";
import { ProposalStore } from "../src/proposal-store";
import { proposalTables } from "../src/proposal-tables";
import type { Thread, ProviderInput } from "../src/threads";
import type { AppIdentity } from "../src/server";
import type { WorkflowHost } from "../src/workflow-host";
const status = (n: number) => (error: unknown) =>
  error instanceof Response && error.status === n;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
async function fixture(
  retry: "same-request" | "inspect" | "default" = "same-request",
  reshape = false,
  routes?: { path: string; description: string }[],
) {
  const client = createClient({ url: ":memory:" });
  const schema = proposalTables("fixture_proposals", "fixture_agent_guard");
  for (const sql of await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(schema),
  ))
    await client.execute(sql);
  const db = {
    query: async (s: { sql: string; params?: unknown[] }) =>
      (
        await client.execute({
          sql: s.sql,
          args: (s.params ?? []) as InValue[],
        })
      ).rows as Record<string, unknown>[],
    batch: async (ss: { sql: string; params?: unknown[] }[]) =>
      client.batch(
        ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })),
        "write",
      ),
  };
  const identity: AppIdentity = {
    userId: "owner",
    installationId: "fixture",
    organizationId: "org",
    owner: { kind: "organization", id: "org" },
    canEdit: true,
    role: "owner",
  };
  const store = new ProposalStore(db, identity, {
      table: "fixture_proposals",
      guard: "fixture_agent_guard",
    }),
    focusId = crypto.randomUUID(),
    threadId = crypto.randomUUID(),
    submissionId = crypto.randomUUID();
  const thread: Thread = {
    ref: { id: threadId },
    id: threadId,
    owner: { kind: "organization", id: "org" },
    installationId: "fixture",
    createdBy: "owner",
    visibility: "private",
    type: "fixture.conversation",
    typeVersion: 1,
    title: "Private",
    status: "active",
    context: { type: "fixture.page", id: focusId },
    parent: null,
    pinned: false,
    working: true,
    readOnly: false,
    createdAt: 1,
    updatedAt: 1,
  };
  let running = true,
    deleted = false,
    loseResponse = false,
    effects = 0;
  const writes = new Map<string, unknown>(),
    events = new Map<string, unknown>();
  let heldAppend:
    | {
        started: ReturnType<typeof deferred>;
        resume: ReturnType<typeof deferred>;
      }
    | undefined;
  let failAppend = false;
  async function append(input: { sourceKey: string }) {
    if (deleted) throw new Response("Not found", { status: 404 });
    if (failAppend) {
      failAppend = false;
      throw new Error("Timeline unavailable");
    }
    const held = heldAppend;
    heldAppend = undefined;
    if (held) {
      held.started.resolve();
      await held.resume.promise;
    }
    if (!events.has(input.sourceKey))
      events.set(input.sourceKey, { id: crypto.randomUUID() });
    return events.get(input.sourceKey);
  }
  const host = {
    call: async (name: string, input: any) => {
      switch (name) {
        case "threads.get":
          return deleted ? null : thread;
        case "threads.submission":
          return {
            threadId,
            submissionId,
            state: running ? "running" : "aborted",
            replyEntryIds: [],
          };
        case "threads.append":
          return append(input);
        default:
          throw new Error(`Unexpected ${name}`);
      }
    },
  } as WorkflowHost<"interactive">;
  let heldEffect:
    | {
        started: ReturnType<typeof deferred>;
        resume: ReturnType<typeof deferred>;
      }
    | undefined;
  let invocations = 0;
  const action = defineAction({
    access: "write",
    description: "Apply fixture value",
    mcpTool: "fixture_apply",
    input: z.strictObject({ requestId: z.uuid(), value: z.string() }),
    output: z.unknown(),
    run: async (_c: { identity: AppIdentity }, v) => {
      invocations++;
      const held = heldEffect;
      heldEffect = undefined;
      if (held) {
        held.started.resolve();
        await held.resume.promise;
      }
      if (!writes.has(v.requestId)) {
        effects++;
        writes.set(v.requestId, v);
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost effect response");
      }
      return writes.get(v.requestId);
    },
  });
  const read = defineAction({
    access: "read",
    description: "Read fixture value",
    mcpTool: "fixture_read",
    input: z.strictObject({}),
    output: z.unknown(),
    run: () => ({ saved: "value" }),
  });
  const agent = actionAgent({
    store,
    host,
    type: "fixture.conversation",
    contextType: "fixture.page",
    focusId,
    label: "Fixture",
    context: () => ({
      identity,
      actor: { kind: "member" as const, id: "owner" },
      originActor: { kind: "member" as const, id: "owner" },
    }),
    actions: {
      "fixture.apply": {
        action,
        retry: retry === "default" ? undefined : retry,
        prepare: (input, id) => ({
          ...z.record(z.string(), z.unknown()).parse(input),
          requestId: id,
          ...(reshape
            ? {
                value: `${z.record(z.string(), z.unknown()).parse(input).value}!`,
              }
            : {}),
        }),
      },
    },
    reads: { "fixture.read": read },
    instructions: "Fixture",
    page: async () => ({ canonical: true }),
    routes,
  });
  const input: ProviderInput<"tool"> = {
    thread,
    submissionId,
    call: { id: "call-1", name: "fixture_apply", input: { value: "approved" } },
    calls: [],
  };
  return {
    client,
    db,
    identity,
    store,
    agent,
    input,
    thread,
    events,
    effects: () => effects,
    invocations: () => invocations,
    holdEffect: () => {
      const held = { started: deferred(), resume: deferred() };
      heldEffect = held;
      return { started: held.started.promise, release: held.resume.resolve };
    },
    holdAppend: () => {
      const held = { started: deferred(), resume: deferred() };
      heldAppend = held;
      return { started: held.started.promise, release: held.resume.resolve };
    },
    failAppend: () => {
      failAppend = true;
    },
    lose: () => {
      loseResponse = true;
    },
    expire: () => {
      running = false;
    },
    delete: () => {
      deleted = true;
    },
    revisionInput: (id: string) => ({ id, revision: 1 }),
  };
}
test("shared thread callbacks create one stable private proposal per tool call and reads stay transient", async () => {
  const f = await fixture();
  try {
    const first = await f.agent.tool(f.input),
      replay = await f.agent.tool(f.input);
    assert.deepEqual(replay, first);
    const rows = await f.store.forThread(f.thread.id);
    assert.equal(rows.length, 1);
    assert.equal(f.effects(), 0);
    await assert.rejects(
      f.agent.tool({
        ...f.input,
        call: { ...f.input.call, input: { value: "different" } },
      }),
      status(409),
    );
    const read = await f.agent.tool({
      ...f.input,
      call: { ...f.input.call, name: "action_1", input: {} },
    });
    assert.deepEqual(read.output, { saved: "value" });
    assert.equal((await f.store.forThread(f.thread.id)).length, 1);
    const prepared = await f.agent.prepare({
      thread: f.thread,
      submissionId: f.input.submissionId,
      retry: false,
      entry: {} as never,
    });
    assert.equal(
      prepared.tools.find((t) => t.name === "fixture_read")?.store,
      false,
    );
    assert.deepEqual(prepared.tools.map(tool => tool.name), ["fixture_apply", "fixture_read"]);
    assert.match(prepared.tools[0].description, /private proposal.*review/);
  } finally {
    f.client.close();
  }
});
test("lost cross-app result recovers using the exact reviewed request and records the final timeline once", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const row = (await f.store.forThread(f.thread.id))[0];
    f.lose();
    await assert.rejects(
      f.agent.decide(row.id, 1, "approve"),
      /Lost effect response/,
    );
    assert.equal((await f.store.get(row.id)).status, "uncertain");
    assert.equal(f.effects(), 1);
    const recovered = await f.agent.decide(row.id, 1, "approve"),
      replayed = await f.agent.decide(row.id, 1, "approve");
    assert.deepEqual(replayed, recovered);
    assert.equal(f.effects(), 1);
    assert.equal(f.events.size, 2);
  } finally {
    f.client.close();
  }
});
test("current permission, expired replies, private thread identity and proposal owner remain enforced", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.agent.tool({
        ...f.input,
        thread: { ...f.thread, visibility: "organization" },
      }),
      status(409),
    );
    await assert.rejects(
      f.agent.tool({
        ...f.input,
        thread: { ...f.thread, createdBy: "another" },
      }),
      status(409),
    );
    await f.agent.tool(f.input);
    const row = (await f.store.forThread(f.thread.id))[0];
    f.identity.canEdit = false;
    await assert.rejects(f.agent.decide(row.id, 1, "approve"), status(403));
    assert.equal(f.effects(), 0);
    const other = new ProposalStore(
      f.db,
      { ...f.identity, userId: "another" },
      { table: "fixture_proposals", guard: "fixture_agent_guard" },
    );
    await assert.rejects(other.get(row.id), status(404));
    assert.deepEqual(await other.unresolved(), []);
    f.expire();
    await assert.rejects(
      f.agent.tool({ ...f.input, call: { ...f.input.call, id: "later" } }),
      status(409),
    );
  } finally {
    f.client.close();
  }
});
for (const retry of ["inspect", "default"] as const)
  test(`${retry} uncertain actions cannot replay; dismissal does not claim an undo`, async () => {
    const f = await fixture(retry);
    try {
      await f.agent.tool(f.input);
      const row = (await f.store.forThread(f.thread.id))[0];
      f.lose();
      await assert.rejects(f.agent.decide(row.id, 1, "approve"));
      await assert.rejects(f.agent.decide(row.id, 1, "approve"), status(409));
      await f.agent.decide(row.id, 1, "reject");
      const saved = await f.store.get(row.id);
      assert.equal(saved.status, "uncertain");
      assert.equal(JSON.parse(saved.receipt!).outcome, "unconfirmed");
      assert.equal(JSON.parse(saved.receipt!).dismissed, true);
      assert.equal(f.effects(), 1);
    } finally {
      f.client.close();
    }
  });
test("deleting a shared thread cancels pending proposals while retaining applied and uncertain receipts", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const applied = (await f.store.forThread(f.thread.id))[0];
    await f.agent.decide(applied.id, 1, "approve");
    await f.agent.tool({
      ...f.input,
      call: { ...f.input.call, id: "pending" },
    });
    f.delete();
    await f.agent.deleting({
      threadId: f.thread.id,
      type: f.thread.type,
      context: f.thread.context,
    });
    const rows = await f.store.forThread(f.thread.id);
    assert.deepEqual(
      new Set(rows.map((r) => r.status)),
      new Set(["applied", "cancelled"]),
    );
    await assert.rejects(
      f.agent.decide(
        rows.find((r) => r.status === "cancelled")!.id,
        1,
        "approve",
      ),
      status(409),
    );
    assert.equal(f.effects(), 1);
  } finally {
    f.client.close();
  }
});

test("a delayed uncertain projection cannot suppress the final applied receipt after concurrent recovery", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const row = (await f.store.forThread(f.thread.id))[0];
    const delayed = f.holdAppend();
    f.lose();
    const failed = f.agent
      .decide(row.id, 1, "approve")
      .catch((error: unknown) => error);
    await delayed.started;
    f.failAppend();
    await f.agent.decide(row.id, 1, "approve");
    assert.equal((await f.store.get(row.id)).status, "applied");
    delayed.release();
    assert.match(String(await failed), /Lost effect response/);
    assert.equal((await f.store.get(row.id)).timelineEntryId, null);
    await f.agent.forThread(f.thread.id);
    const projected = f.events.get(`app.proposal:${row.id}:1:applied`) as {
      id: string;
    };
    assert.equal((await f.store.get(row.id)).timelineEntryId, projected.id);
    assert.equal(f.effects(), 1);
  } finally {
    f.client.close();
  }
});

test("an inspect action has one exclusive approval claim even when another request holds a stale pending snapshot", async () => {
  const f = await fixture("inspect");
  try {
    await f.agent.tool(f.input);
    const pending = (await f.store.forThread(f.thread.id))[0];
    const effect = f.holdEffect();
    const first = f.agent.decide(pending.id, 1, "approve");
    await effect.started;
    const get = f.store.get.bind(f.store);
    let stale = true;
    f.store.get = async (id) => {
      if (stale) {
        stale = false;
        return pending;
      }
      return get(id);
    };
    await assert.rejects(f.agent.decide(pending.id, 1, "approve"), status(409));
    effect.release();
    await first;
    assert.equal(f.invocations(), 1);
  } finally {
    f.client.close();
  }
});
test("approval invokes the exact prepared input reviewed by the member", async () => {
  const f = await fixture("same-request", true);
  try {
    await f.agent.tool(f.input);
    const pending = (await f.store.forThread(f.thread.id))[0];
    assert.equal(JSON.parse(pending.data).changes.value, "approved!");
    const decided = await f.agent.decide(pending.id, 1, "approve");
    assert.equal((decided.receipt as { value: string }).value, "approved!");
  } finally {
    f.client.close();
  }
});
test("a retained uncertain receipt can recover with current authority after its thread is deleted", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const pending = (await f.store.forThread(f.thread.id))[0];
    f.lose();
    await assert.rejects(f.agent.decide(pending.id, 1, "approve"));
    f.delete();
    await f.agent.deleting({
      threadId: f.thread.id,
      type: f.thread.type,
      context: f.thread.context,
    });
    const context = (await f.agent.browser(
      new Request(`https://fixture/context?focus=${f.thread.context!.id}`),
      "context",
    )) as { unresolved: { id: string }[] };
    assert.deepEqual(
      context.unresolved.map((row) => row.id),
      [pending.id],
    );
    await f.agent.decide(pending.id, 1, "approve");
    const saved = await f.store.get(pending.id);
    assert.equal(saved.status, "applied");
    assert.equal(saved.timelineEntryId, "thread-deleted");
    assert.equal(f.effects(), 1);
  } finally {
    f.client.close();
  }
});
test("malformed browser identifiers return an input error before any write", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.agent.browser(
        new Request("https://fixture/agent/proposals/not-an-id"),
        "proposals/not-an-id",
      ),
      status(400),
    );
    assert.equal(f.effects(), 0);
  } finally {
    f.client.close();
  }
});

test("concurrent replay-safe recoveries converge on the applied receipt", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const pending = (await f.store.forThread(f.thread.id))[0];
    f.lose();
    await assert.rejects(f.agent.decide(pending.id, 1, "approve"));
    const effect = f.holdEffect();
    const first = f.agent.decide(pending.id, 1, "approve");
    await effect.started;
    const second = await f.agent.decide(pending.id, 1, "approve");
    effect.release();
    assert.deepEqual(await first, second);
    assert.equal(f.effects(), 1);
  } finally {
    f.client.close();
  }
});
test("rejecting an applied action or racing a completed recovery returns conflict without claiming a rejection", async () => {
  const f = await fixture();
  try {
    await f.agent.tool(f.input);
    const pending = (await f.store.forThread(f.thread.id))[0];
    f.lose();
    await assert.rejects(f.agent.decide(pending.id, 1, "approve"));
    const uncertain = await f.store.get(pending.id);
    await f.agent.decide(pending.id, 1, "approve");
    await assert.rejects(f.agent.decide(pending.id, 1, "reject"), status(409));
    const get = f.store.get.bind(f.store);
    let stale = true;
    f.store.get = async (id) => {
      if (stale) {
        stale = false;
        return uncertain;
      }
      return get(id);
    };
    await assert.rejects(f.agent.decide(pending.id, 1, "reject"), status(409));
    assert.equal((await get(pending.id)).status, "applied");
    assert.equal(f.effects(), 1);
  } finally {
    f.client.close();
  }
});
test("expiry after proposal creation cancels only the pending draft and records the reason", async () => {
  const f = await fixture();
  try {
    const create = f.store.create.bind(f.store);
    f.store.create = async (input) => {
      const row = await create(input);
      f.expire();
      return row;
    };
    await assert.rejects(f.agent.tool(f.input), status(409));
    const saved = (await f.store.forThread(f.thread.id))[0];
    assert.equal(saved.status, "cancelled");
    assert.equal(JSON.parse(saved.receipt!).reason, "turn expired");
    assert.equal(f.effects(), 0);
  } finally {
    f.client.close();
  }
});
test("the page claim reaches the reply as untrusted context and navigation stays inside the app", async () => {
  const routes = [{ path: "projects/<id>", description: "A project." }];
  const f = await fixture("same-request", false, routes);
  try {
    const prepared = await f.agent.prepare({
      thread: f.thread,
      submissionId: f.input.submissionId,
      retry: false,
      entry: { metadata: { "app.page": { location: "/projects/p1?depth=2", title: "Project", state: { id: "p1" } } } } as never,
    });
    assert.deepEqual(prepared.context, {
      canonical: true,
      currentPage: { location: "projects/p1?depth=2", title: "Project", state: { id: "p1" } },
      routes,
    });
    assert.ok(prepared.tools.some((t) => t.name === "navigate_page"));
    const longTitle = await f.agent.prepare({
      thread: f.thread,
      submissionId: f.input.submissionId,
      retry: false,
      entry: { metadata: { "app.page": { location: "projects/p1", title: "x".repeat(500) } } } as never,
    });
    assert.deepEqual((longTitle.context as { currentPage: unknown }).currentPage, { location: "projects/p1" });
    assert.match(prepared.instructions, /currentPage.*untrusted/);
    const forged = await f.agent.prepare({
      thread: f.thread,
      submissionId: f.input.submissionId,
      retry: false,
      entry: { metadata: { "app.page": { location: "https://evil.example/" } } } as never,
    });
    assert.equal((forged.context as { currentPage: unknown }).currentPage, null);
    const opened = await f.agent.tool({
      ...f.input,
      call: { id: "nav", name: "navigate_page", input: { path: "projects/p1?depth=2", params: { depth: "3", rel: ["a", "b:incoming"] }, label: "Project" } },
    });
    assert.deepEqual(opened.parts, [{ type: "data", name: "app.navigate", version: 1, data: { location: "projects/p1?depth=3&rel=a&rel=b%3Aincoming", label: "Project" } }]);
    for (const path of ["javascript:alert(1)", "projects/../../admin", "a\\b", "a/%2e%2e/%2E%2E/other-app", "a/.%2e/x", "a/%2F/x", "a/%5c/x"]) {
      const refused = await f.agent.tool({ ...f.input, call: { id: "bad", name: "navigate_page", input: { path } } });
      assert.equal(refused.parts, undefined, path);
    }
    assert.equal((await f.store.forThread(f.thread.id)).length, 0);
  } finally {
    f.client.close();
  }
});
