import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { discoverySources, previewDiscovery } from "../src/server/discovery";

// A run reads each direct connection over its range: since the last run by default,
// 7 or 30 days, or everything, continuing where the last unfinished `all` run stopped.
const types = ["Person"].map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, name, category: "node", body: `A ${name}.` }));
const who: AppIdentity = { installationId: "forerunner", userId: "alice", owner: { kind: "user", id: "alice" }, role: "owner", canEdit: true };
const gmail = { id: "c0000000-0000-4000-8000-000000000001", provider: "gmail", resource: "alice@example.test", label: "Alice", operations: ["messages.list", "messages.get"] };
const calendar = { id: "c0000000-0000-4000-8000-000000000002", provider: "google-calendar", resource: "alice@example.test", label: "Alice", operations: ["events.list"] };
const semantic = { entities: [{ key: "bob", name: "Bob", type: "Person", summary: "Wrote about the draft.", existingId: null, certainty: "mentioned", confidence: 0.7, evidence: ["e0"] }], relationships: [] };

function fakeHost(connector: (input: Record<string, unknown>) => unknown) {
  const reads: Record<string, unknown>[] = [];
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    snapshot: () => ({ connections: [gmail, calendar] }),
    "identity.current": () => ({ id: "alice", name: "Alice", email: "alice@example.test" }),
    "workflow.start": (input) => ({ id: input.id }),
    "workflow.collect": () => ({}),
    "session.append": () => ({}),
    "inference.generate": () => ({ output: semantic }),
    "entities.types": () => ["graph-type", "graph-node", "graph-edge"].map((type) => ({ type, installationId: "wiki", writable: true })),
    "connector.execute": (input) => { reads.push(input); return connector(input); },
    "actions.call": () => wikiGraphFixture("wiki", { types: types.map((t) => ({ ref: { installationId: "wiki", type: "graph-type", id: t.id }, attributes: t })) }),
  };
  const host = { call: async (name: string, input: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(name);
    return handler(input);
  } } as unknown as WorkflowHost<"interactive">;
  return { host, reads };
}
async function database() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}
const message = (id: string, date: string) => ({ id, subject: "Draft", snippet: "Bob: here is the draft.", from: "Bob <bob@example.test>", date });
const query = (reads: Record<string, unknown>[]) => reads.filter((r) => r.operation === "messages.list").map((r) => (r.input as { query: string }).query);
const listLimit = (reads: Record<string, unknown>[]) => (reads.find((r) => r.operation === "messages.list")?.input as { maxResults?: number } | undefined)?.maxResults;
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("Gmail reads since the last run, then 7 days, and `all` continues before the oldest message it read", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  let cursor: string | null = "next-page";
  const { host, reads } = fakeHost((input) => input.operation === "messages.list"
    ? { messages: [{ id: "m1" }, { id: "m2" }], cursor }
    : message(String((input.input as { id: string }).id), input.input && (input.input as { id: string }).id === "m1" ? "2026-11-02T10:00:00Z" : "2026-10-01T10:00:00Z"));
  const source = `connection:${gmail.id}`;

  const first = await previewDiscovery(db, who, host, { sources: [source] });
  const [since] = query(reads);
  assert.match(since, /^-in:spam -in:trash -category:promotions after:\d+$/);
  assert.ok(Math.abs(Number(since.split("after:")[1]) - seconds(new Date(Date.now() - 14 * 86_400_000).toISOString())) < 60, "no earlier run: 14 days");
  assert.equal(first.sources[0].range, "since-last");
  assert.equal(listLimit(reads), 40);

  reads.length = 0;
  await previewDiscovery(db, who, host, { sources: [source] });
  assert.equal(query(reads)[0], `-in:spam -in:trash -category:promotions after:${seconds(first.createdAt)}`);

  reads.length = 0;
  await previewDiscovery(db, who, host, { sources: [source], range: "7d" });
  assert.ok(Math.abs(Number(query(reads)[0].split("after:")[1]) - seconds(new Date(Date.now() - 7 * 86_400_000).toISOString())) < 60);

  reads.length = 0;
  const all = await previewDiscovery(db, who, host, { sources: [source], range: "all" });
  assert.equal(query(reads)[0], "-in:spam -in:trash -category:promotions", "everything: no date bound");
  assert.equal(all.sources[0].more, true);
  assert.deepEqual(all.sources[0].next, { to: "2026-10-01T10:00:00.000Z" });

  reads.length = 0;
  cursor = null;
  const rest = await previewDiscovery(db, who, host, { sources: [source], range: "all" });
  assert.equal(query(reads)[0], `-in:spam -in:trash -category:promotions before:${seconds("2026-10-01T10:00:00Z")}`);
  assert.equal(rest.sources[0].more, false);

  reads.length = 0;
  await previewDiscovery(db, who, host, { sources: [source], range: "all" });
  assert.equal(query(reads)[0], "-in:spam -in:trash -category:promotions", "a finished `all` starts again");

  const listed = await discoverySources(db, who, host);
  const found = listed.sources.find((s) => s.id === source);
  assert.ok(found && "lastRunAt" in found && String(found.lastRunAt) > first.createdAt, "the sources list shows the latest run");
});

test("Calendar pages through events and splits the 40-record budget with Gmail", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const event = (i: number) => ({ id: `e${i}`, summary: `Dinner ${i}`, start: { dateTime: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() } });
  const { host, reads } = fakeHost((input) => {
    if (input.operation === "messages.list") return { messages: [{ id: "m1" }], cursor: null };
    if (input.operation === "messages.get") return message("m1", "2026-11-02T10:00:00Z");
    const page = (input.input as { cursor?: string }).cursor ? 1 : 0;
    return { items: Array.from({ length: 15 }, (_, i) => event(page * 15 + i)), nextPageToken: page ? "page-2" : "page-1" };
  });
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${calendar.id}`, `connection:${gmail.id}`], range: "30d" });
  const lists = reads.filter((r) => r.operation === "events.list").map((r) => r.input as { timeMin: string; maxResults: number; cursor?: string });
  assert.deepEqual(lists.map((l) => [l.maxResults, l.cursor]), [[21, undefined], [6, "page-1"]]);
  assert.ok(Math.abs(Date.parse(lists[0].timeMin) - (Date.now() - 30 * 86_400_000)) < 60_000);
  const [read] = preview.sources;
  assert.equal(read.count, 20, "half of the 40-record budget");
  assert.equal(read.more, true);
  assert.equal(read.next?.from, event(19).start.dateTime);
  assert.equal(listLimit(reads), 20);
});

test("a 30-day Gmail run persists all 40 long inputs after bounded analysis, and no preview after a later batch fails", async (t) => {
  const { client, db } = await database();
  t.after(() => client.close());
  const { host: baseHost } = fakeHost(input => input.operation === "messages.list"
    ? { messages: Array.from({ length: 40 }, (_, i) => ({ id: `long-${i}` })), cursor: "more-mail" }
    : { ...message(String((input.input as { id: string }).id), "2026-11-04T12:00:00Z"), text: "Bob discusses the synthetic draft. ".repeat(150) });
  let calls = 0, failAt = 0;
  const host = { call: async (op: string, input: Record<string, unknown>) => {
    if (op !== "inference.generate") return baseHost.call(op as never, input as never);
    ++calls;
    if (failAt === calls) throw new Response("Provider unavailable", { status: 503 });
    if (JSON.stringify(input.data).length > 65_536) throw new Response("Step data too large", { status: 413 });
    const data = input.data as { evidence: { ref: string }[] };
    return { output: { ...semantic, entities: semantic.entities.map(e => ({ ...e, evidence: [data.evidence[0].ref] })) } };
  } } as unknown as WorkflowHost<"interactive">;
  const preview = await previewDiscovery(db, who, host, { sources: [`connection:${gmail.id}`], range: "30d" });
  assert.ok(calls > 1);
  assert.equal(preview.inputs?.length, 40);
  assert.equal(preview.sources[0].range, "30d");
  assert.equal(preview.sources[0].more, true, "Existing read cap remains explicit");
  let rows = await client.execute("SELECT kind, data FROM forerunner_discovery_records");
  const run = rows.rows.filter(r => r.kind === "run").map(r => JSON.parse(String(r.data)))[0];
  assert.equal(run.status, "complete");
  assert.equal(run.analysisBatchCount, calls);
  assert.equal(run.analysisBatchesCompleted, calls);
  assert.equal(run.input.evidence.length, 41);
  assert.equal(run.output.entities.length, calls);
  assert.equal(rows.rows.filter(r => r.kind === "preview").length, 1);

  failAt = calls + 2;
  await assert.rejects(previewDiscovery(db, who, host, { sources: [`connection:${gmail.id}`], range: "30d" }), (error: unknown) => error instanceof Response && error.status === 503);
  rows = await client.execute("SELECT kind, data FROM forerunner_discovery_records");
  assert.equal(rows.rows.filter(r => r.kind === "preview").length, 1, "The previous preview is preserved; no partial replacement exists");
  const failed = rows.rows.filter(r => r.kind === "run").map(r => JSON.parse(String(r.data))).find(r => r.status === "failed");
  assert.equal(failed.failedWhile, "analyzing");
  assert.equal(failed.analysisBatchesCompleted, 1);
  assert.equal(failed.error, "Provider unavailable");
  assert.equal(failed.output, undefined, "Partial answers are not recorded as a completed output");
});
