import assert from "node:assert/strict";
import test from "node:test";
import { briefSlug, dailyHomeDates, readDailyHome, savedBrief } from "../src/server/daily-home";

test("DailyHome uses the previous complete Monday-Sunday week in the selected local timezone", () => {
  assert.deepEqual(dailyHomeDates(Date.parse("2026-11-12T12:00:00Z"), "America/Chicago"), {
    date: "2026-11-12", yesterday: "2026-11-11", weekStart: "2026-11-02", weekEnd: "2026-11-08",
    weekDates: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"],
  });
  assert.equal(dailyHomeDates(Date.parse("2026-11-08T06:30:00Z"), "America/Chicago").date, "2026-11-08");
  assert.equal(dailyHomeDates(Date.parse("2026-11-09T05:30:00Z"), "America/Chicago").date, "2026-11-08");
});

test("DailyHome refuses organization installations before reading schedules or reports", async () => {
  let called = false;
  const host = { call: async () => { called = true; throw new Error("unexpected host call"); } } as never;
  const identity = { owner: { kind: "organization", id: "org" }, userId: "alice", installationId: "f", canEdit: true, role: "owner" } as never;
  await assert.rejects(() => readDailyHome({} as never, identity, host, {}), (error: unknown) => error instanceof Response && error.status === 403);
  assert.equal(called, false);
});

const alice = { owner: { kind: "user", id: "alice" }, userId: "alice", installationId: "forerunner", canEdit: true, role: "owner" } as never;
type Saved = { id: string; revision: number; generatedBody: string; provenance?: string; archived?: boolean };
type Call = { operation: string; action?: string; query?: string };
const refuse = (operation: string): unknown => { throw new Error(`unexpected host call ${operation}`); };
/** A personal Wiki holding `saved` briefs by date. Any other host operation is answered by `extra`, which refuses by default. */
async function wikiHost(saved: Record<string, Saved>, extra: (operation: string) => unknown = refuse) {
  const bySlug = new Map<string, Saved>();
  for (const [date, doc] of Object.entries(saved)) bySlug.set(await briefSlug(alice, date, "America/Chicago"), doc);
  const calls: Call[] = [];
  const host = { call: async (operation: string, input: { installationId?: string; action?: string; input?: { query: string; variables: Record<string, string> } }) => {
    calls.push({ operation, action: input.action, query: input.input?.query });
    if (operation === "actions.list") return [{ installationId: "wiki", actions: [{ name: "graph.describe", access: "read", permitted: true }] }];
    if (operation === "actions.call" && input.installationId === "wiki") {
      if (input.action === "graph.describe") return { version: 1, contracts: [{ id: "outfitter.wiki-documents", version: 1 }], capabilities: ["documents"], types: [], queryAction: "graph.graphql" };
      const { query, variables } = input.input ?? { query: "", variables: {} };
      if (query.includes("DailyHomePages")) return { data: Object.fromEntries(Object.entries(variables).map(([name, slug]) => [`d${name.slice(1)}`, bySlug.has(slug) ? { documentId: bySlug.get(slug)?.id } : null])) };
      if (query.includes("DailyHomeDocuments")) return { data: Object.fromEntries(Object.entries(variables).map(([name, id]) => {
        const doc = [...bySlug.values()].find(item => item.id === id);
        if (!doc) throw new Error("Unknown document");
        const alias = `b${name.slice(1)}`;
        // The body is returned only where the query selected it.
        const body = query.split(`${alias}:document`)[1].split("}")[0].includes("generatedBody");
        return [alias, { id: doc.id, revision: doc.revision, ...(body ? { generatedBody: doc.generatedBody } : {}), provenance: doc.provenance ?? '{"kind":"forerunner.daily-brief"}', archived: doc.archived ?? false, createdAt: "2026-11-12T11:00:00.000Z" }];
      })) };
    }
    return extra(operation);
  } } as never;
  return { host, calls };
}
const noon = Date.parse("2026-11-12T18:00:00Z");
const schedules = (operation: string) => operation === "schedules"
  ? [{ id: "s", workflowId: "forerunner-daily-brief", timezone: "America/Chicago", cron: "0 5 * * *", enabled: true }]
  : refuse(operation);

test("DailyHome reads an exact Wiki revision with redacted provenance through authorized read actions", async () => {
  const { host, calls } = await wikiHost({ "2026-11-12": { id: "doc", revision: 4, generatedBody: "# Saved brief" } });
  const result = await savedBrief(host, alice, "2026-11-12", "America/Chicago");
  assert.equal(result?.documentId, "doc");
  assert.equal(result?.revision, 4);
  assert.equal(result?.markdown, "# Saved brief");
  assert.equal(result?.status, "incomplete");
  assert.equal(result?.date, "2026-11-12");
  assert.match(result?.href ?? "", /revision=4$/);
  assert.ok(calls.every(call => call.action !== "graph.mutate"));
});

test("the digest section reads the saved brief without reports, priorities, generation or writes", async () => {
  const { host, calls } = await wikiHost({
    "2026-11-12": { id: "today", revision: 2, generatedBody: "# Today" },
    "2026-11-11": { id: "yesterday", revision: 5, generatedBody: "# Yesterday" },
  }, schedules);
  const db = new Proxy({}, { get() { throw new Error("The digest must not read the board"); } });
  const result = await readDailyHome(db as never, alice, host, { sections: ["digest"] }, noon);
  assert.equal(result.briefState, "saved");
  assert.equal(result.brief?.markdown, "# Today");
  assert.equal(result.brief?.savedAt, "2026-11-12T11:00:00.000Z");
  // Yesterday is a reference for setup detection: revision and link, no body.
  assert.equal(result.previousBrief?.revision, 5);
  assert.equal(result.previousBrief?.markdown, "");
  assert.equal(result.latestBrief, null);
  assert.equal(result.schedule?.timezone, "America/Chicago");
  assert.ok(!("yesterday" in result) && !("priorities" in result) && !("previousWeek" in result));
  // One schedule read, one provider resolution, one page lookup and one document read. Nothing else.
  assert.deepEqual(calls.map(call => call.operation === "actions.call" ? call.action : call.operation), ["schedules", "actions.list", "graph.describe", "graph.graphql", "graph.graphql"]);
  assert.deepEqual(Object.keys(result.timings).sort(), ["briefLookup", "briefRead", "schedule", "wikiProvider"]);
  assert.ok(Object.values(result.timings).every(value => typeof value === "number"));
});

test("a missing brief is explicit and offers the last dated snapshot, never as today's", async () => {
  const { host } = await wikiHost({ "2026-11-09": { id: "old", revision: 3, generatedBody: "# Monday" }, "2026-11-01": { id: "ancient", revision: 1, generatedBody: "# Too old" } }, schedules);
  const result = await readDailyHome({} as never, alice, host, { sections: ["digest"] }, noon);
  assert.equal(result.briefState, "missing");
  assert.equal(result.brief, null);
  assert.equal(result.previousBrief, null);
  assert.equal(result.latestBrief?.date, "2026-11-09");
  assert.equal(result.latestBrief?.markdown, "# Monday");
  assert.ok(result.warnings.includes("No saved daily brief is available for 2026-11-12."));
  const empty = await readDailyHome({} as never, alice, (await wikiHost({}, schedules)).host, { sections: ["digest"] }, noon);
  assert.equal(empty.briefState, "missing");
  assert.equal(empty.latestBrief, null);
});

test("an archived brief is not shown, and an unreadable one is reported rather than treated as missing", async () => {
  const archived = await wikiHost({ "2026-11-12": { id: "today", revision: 2, generatedBody: "# Archived", archived: true }, "2026-11-11": { id: "prior", revision: 1, generatedBody: "# Prior" } }, schedules);
  const result = await readDailyHome({} as never, alice, archived.host, { sections: ["digest"] }, noon);
  assert.equal(result.brief, null);
  assert.equal(result.briefState, "missing");
  assert.equal(result.latestBrief, null);
  assert.equal(result.previousBrief?.revision, 1);
  const foreign = await wikiHost({ "2026-11-12": { id: "today", revision: 2, generatedBody: "# Not a brief", provenance: '{"kind":"someone.else"}' } }, schedules);
  const refused = await readDailyHome({} as never, alice, foreign.host, { sections: ["digest"] }, noon);
  assert.equal(refused.brief, null);
  assert.equal(refused.briefState, "unavailable");
  assert.ok(refused.warnings.includes("The saved daily brief for 2026-11-12 could not be read."));
});

test("a section given its time zone reads neither the schedule nor the Wiki", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const { fileURLToPath } = await import("node:url");
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  try {
    const { host, calls } = await wikiHost({});
    const result = await readDailyHome(db as never, alice, host, { sections: ["priorities"], timezone: "America/Chicago" }, noon);
    assert.deepEqual(result.priorities, []);
    assert.equal(result.date, "2026-11-12");
    assert.deepEqual(calls, []);
    assert.ok(!("brief" in result) && !("schedule" in result));
  } finally { client.close(); }
});
