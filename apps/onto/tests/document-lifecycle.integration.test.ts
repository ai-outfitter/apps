import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import {
  putDefinition,
  createDocument,
  readLive,
  enqueue,
  lease,
  retry,
  complete,
  getRevision,
  seal,
  evaluatePolicy,
  deliverEvents,
  requireExportReadiness,
  type Host,
} from "../src/server/documents/service";
import { issueDraft } from "../src/server/documents/examples";

async function setup() {
  const client = createClient({ url: "file::memory:" });
  const migration = await readFile(
    new URL("../migrations/0013_documents.sql", import.meta.url),
    "utf8",
  );
  await client.executeMultiple(migration);
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
  let calls = 0;
  const host: Host = {
    read: async () => ({
      complete: true,
      provenance: { revision: 1 },
      snapshot: { value: 1 },
    }),
    verifyCapture: async () => true,
    policy: async (binding) => ({ binding, decision: "allow" }),
    deliver: async () => ({ receipt: ++calls }),
  };
  const scope = { owner: "org", identity: { owner: { kind: "organization" as const, id: "org" }, installationId: "onto" } };
  await putDefinition(db, scope, "review", 1, {
    sources: [{ provider: "graph", config: "business-review-fixture" }],
    policy: { provider: "policy", config: "v1", required: true },
    eventConsumer: { provider: "consumer", config: "v1" },
  });
  await createDocument(db, scope, "doc", "review", 1);
  return { db, host, scope, client };
}
test("superseded and expired workers cannot publish; retries preserve immutable revisions", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "old");
  await lease(db, scope, "old", "a", 1, 10);
  await enqueue(db, scope, "doc", "new");
  await lease(db, scope, "new", "b", 1, 10);
  await assert.rejects(
    complete(db, scope, "old", "a", 2, { text: "old" }, capture),
  );
  await retry(db, scope, "new", "b", 2, "temporary");
  await lease(db, scope, "new", "c", 3, 10);
  await assert.rejects(complete(db, scope, "new", "b", 4, {}, capture));
  const result = await complete(
    db,
    scope,
    "new",
    "c",
    4,
    { text: "new" },
    capture,
  );
  assert.equal(result.revision, 1);
  assert.deepEqual((await getRevision(db, scope, "doc", 1)).payload, {
    text: "new",
  });
  await assert.rejects(getRevision(db, { owner: "other" }, "doc", 1));
});
test("sealing checks complete fresh capture and does not approve; policy binds exact revision", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "one");
  await lease(db, scope, "one", "a", 1, 10);
  const r = await complete(db, scope, "one", "a", 2, {}, capture);
  await assert.rejects(
    seal(
      db,
      scope,
      "doc",
      1,
      r.digest,
      { ...host, verifyCapture: async () => false },
      3,
    ),
  );
  assert.equal(
    (await seal(db, scope, "doc", 1, r.digest, host, 3)).approval,
    "not_requested",
  );
  assert.equal(
    (
      await evaluatePolicy(db, scope, "doc", 1, "publish", {
        ...host,
        policy: async (b) => ({
          binding: { ...b, digest: "stale" },
          decision: "allow",
        }),
      })
    ).decision,
    "unavailable",
  );
  const decision = await evaluatePolicy(db, scope, "doc", 1, "publish", host);
  assert.equal(decision.decision, "allow");
  assert.deepEqual(await deliverEvents(db, scope, host, 3), {
    delivered: 1,
    failed: 0,
  });
  assert.deepEqual(await deliverEvents(db, scope, host, 4), {
    delivered: 0,
    failed: 0,
  });
  await enqueue(db, scope, "doc", "two");
  await lease(db, scope, "two", "b", 4, 10);
  await complete(
    db,
    scope,
    "two",
    "b",
    5,
    {},
    { ...capture, complete: false, errors: ["partial"] },
  );
  await assert.rejects(evaluatePolicy(db, scope, "doc", 1, "publish", host));
  const incomplete = await getRevision(db, scope, "doc", 2);
  await assert.rejects(seal(db, scope, "doc", 2, incomplete.digest, host, 6));
});
test("issue examples remain publication stubs", () => {
  for (const kind of ["feature", "bug"] as const)
    assert.equal(
      issueDraft(kind, "Example", ["source"]).publication.status,
      "STUB",
    );
});

test("required policy denies seal unless exact-bound allow", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "job");
  await lease(db, scope, "job", "token", 1, 10);
  const result = await complete(db, scope, "job", "token", 2, {}, capture);
  for (const decision of ["deny", "require-review", "unavailable"] as const)
    await assert.rejects(
      seal(
        db,
        scope,
        "doc",
        1,
        result.digest,
        { ...host, policy: async (binding) => ({ binding, decision }) },
        3,
      ),
    );
  await assert.rejects(
    seal(
      db,
      scope,
      "doc",
      1,
      result.digest,
      {
        ...host,
        policy: async () => {
          throw new Error("offline");
        },
      },
      3,
    ),
  );
  await assert.rejects(
    seal(
      db,
      scope,
      "doc",
      1,
      result.digest,
      {
        ...host,
        policy: async (binding) => ({
          binding: { ...binding, config: "old" },
          decision: "allow",
        }),
      },
      3,
    ),
  );
  assert.equal(
    (await seal(db, scope, "doc", 1, result.digest, host, 3)).sealed,
    true,
  );
});

test("sealed outbox retries and delivers historical revision after head advances", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "one");
  await lease(db, scope, "one", "a", 1, 10);
  const r = await complete(db, scope, "one", "a", 2, {}, capture);
  await seal(db, scope, "doc", 1, r.digest, host, 3);
  await seal(db, scope, "doc", 1, r.digest, host, 3);
  let attempts = 0;
  const receiver: Host = {
    ...host,
    deliver: async (event) => {
      attempts++;
      assert.equal(event.binding.revision, 1);
      if (attempts === 1) throw new Error("offline");
      return { ack: event.id };
    },
  };
  assert.deepEqual(await deliverEvents(db, scope, receiver, 4), {
    delivered: 0,
    failed: 1,
  });
  await enqueue(db, scope, "doc", "two");
  await lease(db, scope, "two", "b", 5, 10);
  await complete(db, scope, "two", "b", 6, {}, capture);
  assert.deepEqual(await deliverEvents(db, scope, receiver, 7), {
    delivered: 1,
    failed: 0,
  });
  assert.deepEqual(await deliverEvents(db, scope, receiver, 8), {
    delivered: 0,
    failed: 0,
  });
  assert.equal(
    (await db.query({ sql: "SELECT count(*) AS n FROM document_events" }))[0].n,
    1,
  );
});
test("no configured policy permits the exact complete revision", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  await putDefinition(db, scope, "plain", 1, {
    sources: [{ provider: "graph", config: "v1" }],
  });
  await createDocument(db, scope, "plain-doc", "plain", 1);
  const capture = await readLive(db, scope, "plain-doc", host);
  await enqueue(db, scope, "plain-doc", "plain-job");
  await lease(db, scope, "plain-job", "a", 1, 10);
  await complete(db, scope, "plain-job", "a", 2, {}, capture);
  assert.deepEqual(
    await evaluatePolicy(db, scope, "plain-doc", 1, "publish", host),
    { decision: "allow", detail: { reason: "no_policy_configured" } },
  );
});

test("definition can require exact seal before export", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const contract = {
    version: 1 as const,
    identity: "report",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    params: {},
    rendering: { mode: "template" as const, template: "evidence" as const },
    refresh: "manual" as const,
    requirements: { evidence: true, seal: true, export: true },
  };
  await putDefinition(db, scope, "protected", 1, {
    sources: [{ provider: "graph", config: "v1" }],
    contract,
  });
  await createDocument(db, scope, "protected-doc", "protected", 1);
  const capture = await readLive(db, scope, "protected-doc", host);
  await enqueue(db, scope, "protected-doc", "protected-job");
  await lease(db, scope, "protected-job", "a", 1, 10);
  const r = await complete(db, scope, "protected-job", "a", 2, {}, capture);
  await assert.rejects(requireExportReadiness(db, scope, "protected-doc", 1));
  await seal(db, scope, "protected-doc", 1, r.digest, host, 3);
  await requireExportReadiness(db, scope, "protected-doc", 1);
});

test("expired delivery lease cannot settle and retry reuses event identity", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "one");
  await lease(db, scope, "one", "a", 1, 10);
  const r = await complete(db, scope, "one", "a", 2, {}, capture);
  await seal(db, scope, "doc", 1, r.digest, host, 3);
  const ids: string[] = [];
  const receiver: Host = {
    ...host,
    deliver: async (e) => {
      ids.push(e.id);
      now += 120_001;
      return { accepted: true };
    },
  };
  assert.deepEqual(await deliverEvents(db, scope, receiver, now), {
    delivered: 0,
    failed: 1,
  });
  assert.equal(
    (await db.query({ sql: "SELECT state FROM document_events" }))[0].state,
    "leased",
  );
  const next: Host = {
    ...host,
    deliver: async (e) => {
      ids.push(e.id);
      return { accepted: true };
    },
  };
  assert.deepEqual(await deliverEvents(db, scope, next, now), {
    delivered: 1,
    failed: 0,
  });
  assert.equal(ids[0], ids[1]);
});

test("expired generation lease cannot write an immutable revision", async (t) => {
  const { db, host, scope, client } = await setup();
  t.after(() => client.close());
  const capture = await readLive(db, scope, "doc", host);
  await enqueue(db, scope, "doc", "job");
  await lease(db, scope, "job", "token", 100, 10);
  await assert.rejects(complete(db, scope, "job", "token", 110, {}, capture));
  assert.equal(
    (await db.query({ sql: "SELECT COUNT(*) AS n FROM document_revisions" }))[0]
      .n,
    0,
  );
});

test("policy subject binds trusted producer, owner, action and configuration to the current revision", async () => {
  const { db, host, scope, client } = await setup();
  try {
    const capture = await readLive(db, scope, "doc", host);
    await enqueue(db, scope, "doc", "subject-job");
    await lease(db, scope, "subject-job", "worker", 1, 10);
    const revision = await complete(
      db,
      scope,
      "subject-job",
      "worker",
      2,
      {},
      capture,
    );
    const { policySubject } = await import("../src/server/documents/service");
    const binding = {
      version: 1 as const,
      producer: { installationId: "onto" },
      owner: { kind: "organization" as const, id: "org" },
      documentId: "doc",
      revision: 1,
      digest: revision.digest,
      action: "seal",
      provider: "policy",
      config: "rules",
    };
    // The fixture's configured provider and config are authoritative.
    const definition = await db.query({
      sql: "SELECT definition FROM document_definitions WHERE owner=? AND id=?",
      params: [scope.owner, "review"],
    });
    const configured = JSON.parse(String(definition[0].definition)).policy;
    binding.provider = configured.provider;
    binding.config = configured.config;
    const first = await policySubject(db, scope, binding);
    const changed = await policySubject(db, scope, {
      ...binding,
      action: "publish",
    });
    assert.notEqual(first.digest, changed.digest);
    for (const altered of [
      { ...binding, producer: { installationId: "other" } },
      { ...binding, owner: { kind: "organization" as const, id: "other" } },
      { ...binding, config: "other" },
      { ...binding, digest: "0".repeat(64) },
      { ...binding, revision: 2 },
    ])
      await assert.rejects(policySubject(db, scope, altered));
    await enqueue(db, scope, "doc", "next");
    await lease(db, scope, "next", "worker", 3, 10);
    await complete(db, scope, "next", "worker", 4, {}, capture);
    await assert.rejects(policySubject(db, scope, binding));
  } finally {
    client.close();
  }
});
