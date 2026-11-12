import assert from "node:assert/strict";
import test from "node:test";
import { dailyHomeDates, readDailyHome, savedBrief } from "../src/server/daily-home";

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

test("DailyHome reads an exact Wiki revision with redacted provenance through authorized read actions", async () => {
  const calls: { operation: string; action?: string }[] = [];
  const host = { call: async (operation: string, input: { action?: string; input?: { query?: string } }) => {
    calls.push({ operation, action: input.action });
    if (operation === "actions.list") return [{ installationId: "wiki", actions: [{ name: "graph.describe", access: "read", permitted: true }] }];
    if (input.action === "graph.describe") return { version: 1, contracts: [{ id: "outfitter.wiki-documents", version: 1 }], capabilities: ["documents"], types: [], queryAction: "graph.graphql" };
    if (input.input?.query?.includes("DailyHomePage")) return { data: { page: { documentId: "doc" } } };
    if (input.input?.query?.includes("DailyHomeDocument")) return { data: { document: { id: "doc", revision: 4, generatedBody: "# Saved brief", provenance: '{"kind":"forerunner.daily-brief"}', archived: false } } };
    throw new Error("Unexpected action");
  } } as never;
  const identity = { owner: { kind: "user", id: "alice" }, userId: "alice", installationId: "forerunner", canEdit: true, role: "owner" } as never;
  const result = await savedBrief(host, identity, "2026-11-12", "America/Chicago");
  assert.equal(result?.documentId, "doc");
  assert.equal(result?.revision, 4);
  assert.equal(result?.markdown, "# Saved brief");
  assert.equal(result?.status, "incomplete");
  assert.match(result?.href ?? "", /revision=4$/);
  assert.ok(calls.every(call => call.action !== "graph.mutate"));
});
