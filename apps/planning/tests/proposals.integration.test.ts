import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { migrationStatements } from "@ai-outfitter/app-sdk/migrations";
import { type Client, createClient, type InValue } from "@libsql/client";
import { type BatchDatabase, ProposalStore } from "../src/server/proposals";

const migrations = new URL("../migrations/", import.meta.url);
const status = (n: number) => (e: unknown) => e instanceof Response && e.status === n;

async function apply(client: Client, names: string[]) {
  for (const name of names)
    await client.batch(
      migrationStatements(await readFile(new URL(name, migrations), "utf8")),
      "write",
    );
}
function adapter(client: Client): BatchDatabase {
  return {
    query: async (s) =>
      (await client.execute({ sql: s.sql, args: (s.params ?? []) as InValue[] }))
        .rows as Record<string, unknown>[],
    batch: async (ss) =>
      client.batch(
        ss.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InValue[] })),
        "write",
      ),
  };
}
async function files() {
  return (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort();
}

test("0003 keeps decided and uncertain receipts, cancels only pending drafts and drops app-local transcripts", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    await client.execute("PRAGMA foreign_keys=ON");
    const all = await files();
    const before = all.filter((f) => f < "0003");
    await apply(client, before);
    const conversation = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO planning_agent_conversations(id,installationId,ownerId,focusId,messages,updatedAt) VALUES(?,?,?,?,?,?)",
      args: [conversation, "one", "alice", crypto.randomUUID(), '[{"role":"user","content":"old"}]', 1],
    });
    const legacy: Record<string, { status: string; receipt: string | null }> = {
      pending: { status: "pending", receipt: null },
      applied: { status: "applied", receipt: '{"id":"x","revision":2}' },
      rejected: { status: "rejected", receipt: '{"rejected":true}' },
      executing: { status: "executing", receipt: null },
      unconfirmed: { status: "unconfirmed", receipt: '{"dismissed":true,"outcome":"unconfirmed"}' },
    };
    const ids: Record<string, string> = {};
    for (const [name, row] of Object.entries(legacy)) {
      ids[name] = crypto.randomUUID();
      await client.execute({
        sql: "INSERT INTO planning_agent_proposals(id,conversationId,revision,status,data,receipt) VALUES(?,?,?,?,?,?)",
        args: [ids[name], conversation, 2, row.status, JSON.stringify({ action: "amend_project", projectId: "p1", marker: name }), row.receipt],
      });
    }
    await apply(client, all.filter((f) => f >= "0003"));
    const rows = (await client.execute("SELECT * FROM planning_proposals")).rows;
    const by = (name: string) => rows.find((r) => r.id === ids[name])!;
    assert.equal(rows.length, 5);
    assert.equal(by("pending").status, "cancelled");
    assert.match(String(by("pending").receipt), /cancelled/);
    assert.equal(by("applied").status, "applied");
    assert.equal(by("applied").receipt, legacy.applied.receipt);
    assert.equal(by("rejected").status, "rejected");
    assert.equal(by("executing").status, "uncertain");
    assert.equal(by("executing").receipt, null);
    assert.equal(by("unconfirmed").status, "uncertain");
    assert.equal(by("unconfirmed").receipt, legacy.unconfirmed.receipt);
    for (const row of rows) {
      assert.equal(row.ownerId, "alice");
      assert.equal(row.installationId, "one");
      assert.equal(row.revision, 2);
      assert.equal(row.createdAt, null, "no fabricated timestamps");
      assert.match(String(row.data), /marker/);
    }
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")).rows.map((r) => r.name);
    for (const gone of ["planning_agent_conversations", "planning_agent_turns", "planning_agent_proposals", "planning_agent_project_cleanup"])
      assert.ok(!tables.includes(gone), `${gone} removed`);
    // The receipts table has no conversation foreign key.
    assert.equal((await client.execute("PRAGMA foreign_key_list(planning_proposals)")).rows.length, 0);
  } finally {
    client.close();
  }
});

async function fresh() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await apply(client, await files());
  return client;
}

test("request keys are stable submission identities with exact payload and owner checks", async () => {
  const client = await fresh();
  try {
    const db = adapter(client);
    const alice = new ProposalStore(db, { installationId: "one", userId: "alice" });
    const bob = new ProposalStore(db, { installationId: "one", userId: "bob" });
    const input = { threadId: "t1", turnId: "turn", requestKey: "turn:call-1", action: "amend_project", projectId: "p1", data: { changes: { goals: "A" }, b: 1 } };
    const first = await alice.create(input);
    // Same values in a different field order are the same request.
    const replay = await alice.create({ ...input, data: { b: 1, changes: { goals: "A" } } });
    assert.equal(replay.id, first.id);
    await assert.rejects(alice.create({ ...input, data: { changes: { goals: "B" } } }), status(409));
    await assert.rejects(alice.create({ ...input, threadId: "t2" }), status(409));
    await assert.rejects(bob.create(input), status(409));
    assert.equal((await client.execute("SELECT count(*) AS n FROM planning_proposals")).rows[0].n, 1);
    // Standalone owner and installation checks, independent of any conversation.
    await assert.rejects(bob.get(first.id), status(404));
    await assert.rejects(new ProposalStore(db, { installationId: "two", userId: "alice" }).get(first.id), status(404));
    assert.deepEqual(await bob.forThread("t1"), []);
    // Another installation may reuse the key independently.
    const other = await new ProposalStore(db, { installationId: "two", userId: "alice" }).create(input);
    assert.notEqual(other.id, first.id);
  } finally {
    client.close();
  }
});

test("thread deletion cancels pending proposals only; decided and uncertain receipts survive and cannot be re-decided", async () => {
  const client = await fresh();
  try {
    const db = adapter(client);
    const alice = new ProposalStore(db, { installationId: "one", userId: "alice" });
    const bob = new ProposalStore(db, { installationId: "one", userId: "bob" });
    const make = (store: ProposalStore, key: string) =>
      store.create({ threadId: "shared", requestKey: key, action: "amend_project", data: { key } });
    const pending = await make(alice, "a"), applied = await make(alice, "b"), rejected = await make(alice, "c"),
      uncertain = await make(alice, "d"), others = await make(bob, "e");
    await alice.decide(applied.id, 1, [], { id: "x", revision: 2 });
    await alice.decide(rejected.id, 1, [], { rejected: true }, "rejected");
    await alice.decide(uncertain.id, 1, [], { outcome: "unconfirmed" }, "uncertain");
    await alice.cancelThread("shared");
    const after = Object.fromEntries((await client.execute("SELECT id,status,receipt FROM planning_proposals")).rows.map((r) => [r.id, r]));
    assert.equal(after[pending.id].status, "cancelled");
    assert.equal(after[others.id].status, "cancelled", "every member's pending proposal in the deleted thread");
    assert.equal(after[applied.id].status, "applied");
    assert.equal(after[applied.id].receipt, '{"id":"x","revision":2}');
    assert.equal(after[rejected.id].status, "rejected");
    assert.equal(after[uncertain.id].status, "uncertain");
    await assert.rejects(alice.decide(pending.id, 1, [], {}), status(409));
    // Exact duplicate decision replays the committed receipt.
    assert.equal((await alice.decide(applied.id, 1, [], { ignored: true })).receipt, '{"id":"x","revision":2}');
  } finally {
    client.close();
  }
});

test("a failed guard rolls back the domain write and receipt together", async () => {
  const client = await fresh();
  try {
    const db = adapter(client);
    const alice = new ProposalStore(db, { installationId: "one", userId: "alice" });
    const proposal = await alice.create({ threadId: "t", requestKey: "k", action: "create_project", data: {} });
    const now = Date.now();
    const insert = {
      sql: "INSERT INTO planning_projects(id,installationId,name,revision,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)",
      params: ["p-new", "one", "New", 1, "alice", "alice", now, now],
    };
    await assert.rejects(
      alice.decide(proposal.id, 1, [insert, alice.guard("0")], { id: "p-new" }),
      status(409),
    );
    assert.equal((await client.execute("SELECT count(*) AS n FROM planning_projects")).rows[0].n, 0);
    assert.equal((await alice.get(proposal.id)).status, "pending");
    assert.equal((await client.execute("SELECT count(*) AS n FROM planning_agent_guard")).rows[0].n, 0);
    await alice.decide(proposal.id, 1, [insert], { id: "p-new" });
    assert.equal((await client.execute("SELECT count(*) AS n FROM planning_projects")).rows[0].n, 1);
    // Wrong revision of an applied proposal is a conflict, not a replay.
    await assert.rejects(alice.decide(proposal.id, 2, [insert], {}), status(409));
    assert.equal((await client.execute("SELECT count(*) AS n FROM planning_projects")).rows[0].n, 1);
    // Project deletion cancels pending proposals that target it.
    const target = await alice.create({ threadId: "t", requestKey: "k2", action: "amend_project", projectId: "p-new", data: {} });
    await client.execute("DELETE FROM planning_projects WHERE id='p-new'");
    assert.equal((await alice.get(target.id)).status, "cancelled");
    assert.equal((await alice.get(proposal.id)).status, "applied");
  } finally {
    client.close();
  }
});
