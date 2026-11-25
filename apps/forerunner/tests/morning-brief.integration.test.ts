import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { type InstallationSchedule, type WorkflowHost, scheduleResult, workflowHostPath } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { authoredWiki, chicagoFallback, oceanMorning, otherPriority, ownPriority, timezone } from "../evals/daily-brief/issue-273-fixtures";
import { scheduledDailyBrief } from "../src/server/daily-brief";
import { itemCompletions, items } from "../src/server/schema";

const owner = { installationId: "forerunner-test", userId: "member", owner: { kind: "user", id: "member" }, role: "owner", canEdit: true } satisfies AppIdentity;
const hour = 3_600_000;
const morning = Date.parse(oceanMorning.briefAt);
const discoveryAt = Date.parse(oceanMorning.discoveryAt);
const runId = "10000000-0000-4000-8000-000000000001";
const briefSchedule = { id: "morning-brief", workflowId: "forerunner-daily-brief", inputs: {}, connectionId: null, resource: null };
const occurrence = { runId, scheduledFor: morning, trigger: "clock", schedule: briefSchedule };
const onto = { id: "onto-receipt", app: "Onto", scope: "personal", slug: "onto-yesterday", revision: 4, timezone, complete: true, summary: "Two committed record revisions, two pending updates and three rejected updates." };

type Discovery = "waiting" | "ready" | "running" | "failed" | "disabled";
type Prompt = {
  date: string; timezone: string; coversCompletedDay: string;
  evidence: { ref: string; kind: string; text: string }[];
  notKnown: string[];
};
type Write = {
  id?: string; slug?: string; revision?: number; generatedBody: string;
  provenance: { date: string; runId: string; status: string; sources: { recordId?: string; revision?: number; href?: string }[] };
};
type Trace = { operation: string; input: Record<string, unknown> };

async function replay(t: TestContext, fixture: { discovery?: Discovery[]; ownEvidence?: boolean; onto?: boolean | "empty"; ontoTimezone?: string; pendingFor?: number; wiki?: "authored" | "empty" | "unavailable"; dates?: Pick<typeof oceanMorning, "yesterday"> | Pick<typeof chicagoFallback, "yesterday"> } = {}) {
  const client = createClient({ url: ":memory:" });
  t.after(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });

  if (fixture.ownEvidence) {
    const fields = { category: "stone" as const, installationId: owner.installationId, position: 1, createdAt: morning - 100, updatedAt: morning - 100 };
    await db.insert(items).values([{ ...fields, ...ownPriority, ownerId: owner.userId }, { ...fields, ...otherPriority, ownerId: "other-member" }]);
  }

  if (fixture.dates === chicagoFallback) {
    await db.insert(itemCompletions).values(chicagoFallback.completions.map(row => ({
      id: row.id, itemId: row.id, title: row.title, category: "stone", revision: 1, completedAt: Date.parse(row.at),
      installationId: owner.installationId, ownerId: owner.userId,
    })));
  }

  const trace: Trace[] = [];
  const prompts: Prompt[] = [];
  const writes: Write[] = [];
  const outcomes: unknown[] = [];
  const collected = new Map<unknown, unknown>();
  let stored: { id: string; installationId: string; revision: number; generatedBody: string; archived: boolean; slug: string } | undefined;
  const host = {
    async call(operation: string, input: Record<string, unknown>) {
      trace.push({ operation, input });
      switch (operation) {
        case "schedules": {
          const schedules: InstallationSchedule[] = (fixture.discovery ?? []).map((state, i) => ({
            id: oceanMorning.discoveries[i], workflowId: "forerunner-discovery", timezone, cron: "0 7 * * *", enabled: state !== "disabled",
            inputs: { "analyze.inputs.label": oceanMorning.discoveries[i] },
            connectionId: "connector-" + i, resource: "Synthetic account", createdBy: owner.userId,
            nextRunAt: state === "waiting" || state === "disabled" ? discoveryAt : discoveryAt + 24 * hour,
            lastRunAt: state === "waiting" || state === "disabled" ? null : discoveryAt,
            lastRunId: state === "waiting" || state === "disabled" ? null : "discovery-run-" + i,
            lastOutcome: state === "waiting" || state === "disabled" ? null : "started",
          }));
          return [{ ...briefSchedule, enabled: true, timezone, pendingFor: fixture.pendingFor }, ...schedules];
        }
        case "workflow.read": {
          if (!String(input.id).startsWith("discovery-run-")) {
            const value = collected.get(input.id);
            return value ? { run: { status: "complete" }, outputs: { "collect.outputs.brief": { complete: true, value } } } : null;
          }
          const index = Number(String(input.id).split("-").at(-1));
          const state = fixture.discovery?.[index];
          assert.ok(state && state !== "disabled" && state !== "waiting");
          return { run: { status: state === "running" ? "running" : "complete" }, outputs: {
            "analyze.outputs.result": { complete: state !== "running", value: { status: state === "failed" ? "ready" : state, ...(state === "ready" ? { entries: index } : {}) } },
            "suggestions.outputs.result": { complete: state !== "running", value: { status: state === "ready" ? "skipped" : state } },
          } };
        }
        case "platform.document": {
          const variables = input.variables as Record<string, string>;
          if (input.document === "Viewer") return { viewer: { orgs: [] } };
          if (input.document === "DailyAppUpdates") {
            const update = { ...onto, timezone: fixture.ontoTimezone ?? timezone, ...(fixture.onto === "empty" ? { summary: "Zero committed record revisions, pending updates or rejected updates." } : {}) };
            return { data: { dailyAppUpdates: fixture.onto && variables.date === (fixture.dates ?? oceanMorning).yesterday ? [update] : [] } };
          }
          if (input.document === "WikiRevisionActivity") {
            if (fixture.wiki === "unavailable") throw new Response("Wiki coverage unavailable", { status: 503 });
            // Federation owns membership, provenance and window checks. Simulate its two-page authorized answer.
            const rows = fixture.wiki === "authored" ? authoredWiki.filter(row =>
              (row.scope === "personal" || row.scope === "fixture-team") && !("provenance" in row) &&
              row.createdAt >= variables.start && row.createdAt < variables.end) : [];
            return { data: { wikiRevisionActivity: variables.cursor ? rows.slice(1) : rows.slice(0, 1) },
              ...(!variables.cursor && rows.length > 1 ? { next: "wiki-page-2" } : {}) };
          }
          break;
        }
        case "actions.call": {
          const body = input.input as { query: string; variables: { s0?: string; input?: Write } };
          if (input.template !== "wiki-map") break;
          if (input.action === "graph.graphql" && input.readOnly === true && body.query.includes("SavedPages")) {
            return { data: { p0: stored?.slug === body.variables.s0 ? { document: stored } : null } };
          }
          if (input.action === "graph.mutate" && body.query.includes("SaveGeneratedDocument") && body.variables.input) {
            const write = body.variables.input;
            if (stored) assert.deepEqual([write.id, write.revision], [stored.id, stored.revision]);
            stored = { id: "brief-document", installationId: "member-wiki", archived: false,
              slug: write.slug ?? stored!.slug, revision: (stored?.revision ?? 0) + 1, generatedBody: write.generatedBody };
            writes.push(write);
            return { data: { saveGeneratedDocument: { id: stored.id, revision: stored.revision } } };
          }
          break;
        }
        case "workflow.start": return { id: input.id };
        case "workflow.collect":
          assert.equal(input.slot, "collect.outputs.brief");
          assert.equal(collected.has(input.runId), false);
          collected.set(input.runId, input.value);
          outcomes.push(input.value);
          return {};
        case "inference.generate": {
          const data = input.data as Prompt;
          prompts.push(data);
          return { output: { opening: { text: "Fixture brief", evidence: [data.evidence[0].ref] }, highlights: [], attention: [], unsupported: [] } };
        }
      }
      throw new Response("Fixture source unavailable", { status: 503 });
    },
  } as unknown as WorkflowHost<"schedule">;
  return { trace, prompts, writes, outcomes, fire: async (at: number, slot = occurrence, who: AppIdentity = owner) =>
    scheduleResult.parse(await scheduledDailyBrief(db, who, slot, host, at)) };
}

test("Nov 25 waits for all four 07:00 discovery receipts and the previous day's producer before synthesis", async t => {
  const fixture = { discovery: Array<Discovery>(4).fill("waiting"), onto: false, wiki: "authored" as const };
  const app = await replay(t, fixture);
  const early = await app.fire(morning);
  assert.equal(early.outcome, "deferred");
  assert.equal(early.retryAt, morning + 5 * 60_000);
  assert.deepEqual(app.trace.map(call => call.input.document ?? call.operation), ["schedules", "DailyAppUpdates", "Viewer"]);
  fixture.discovery = ["ready", "ready", "ready", "running"];
  fixture.onto = true;
  assert.equal((await app.fire(discoveryAt)).outcome, "deferred");
  fixture.discovery[3] = "ready";
  fixture.onto = false;
  assert.equal((await app.fire(discoveryAt + 60_000)).outcome, "deferred");
  assert.equal(app.prompts.length, 0);
  assert.equal(app.writes.length, 0);
  assert.equal(app.trace.some(call => call.operation === "workflow.start"), false);

  fixture.onto = true;
  app.trace.length = 0;
  assert.deepEqual(await app.fire(discoveryAt + 2 * 60_000), { outcome: "started" });
  const synthesis = app.trace.findIndex(call => call.operation === "inference.generate");
  assert.ok(synthesis > 0);
  const before = app.trace.slice(0, synthesis);
  assert.deepEqual(before.filter(call => call.operation === "workflow.read").map(call => call.input.id),
    [...oceanMorning.discoveries.map((_, i) => "discovery-run-" + i), runId]);
  const start = before.findIndex(call => call.operation === "workflow.start");
  assert.ok(start > before.findLastIndex(call => call.operation === "workflow.read"));
  assert.deepEqual(before.filter(call => call.input.document === "DailyAppUpdates").map(call => call.input.variables),
    [{ date: oceanMorning.yesterday, limit: 50 }]);
  assert.deepEqual(before.filter(call => call.input.document === "WikiRevisionActivity").map(call => call.input.variables),
    [{ start: oceanMorning.start, end: oceanMorning.end, limit: 20 }, { start: oceanMorning.start, end: oceanMorning.end, limit: 20, cursor: "wiki-page-2" }]);
  assert.deepEqual([app.prompts[0].date, app.prompts[0].coversCompletedDay, app.prompts[0].timezone],
    [oceanMorning.date, oceanMorning.yesterday, timezone]);
  assert.deepEqual(app.writes[0].provenance.sources.filter(source => source.href?.includes("/wiki-map/")), [
    { ref: "app1", kind: "app-update", scope: "personal", recordId: onto.id, revision: onto.revision, href: "/apps/wiki-map/p/onto-yesterday?revision=4" },
    { ref: "wiki1", kind: "wiki-activity", scope: "personal", recordId: "doc-authored", revision: 3, href: "/apps/wiki-map/p/review-notes?revision=3" },
    { ref: "wiki2", kind: "wiki-activity", scope: "fixture-team", recordId: "legacy-authored", revision: 2, href: "/o/fixture-team/wiki-map/revision/legacy/legacy-authored?revision=2" },
  ]);
  assert.deepEqual(app.prompts[0].evidence.filter(row => row.kind === "discovery").map(row => row.text),
    oceanMorning.discoveries.map((label, i) => `Discovery: ${label} completed this morning: ${i} analyzed entries.`));
  assert.doesNotMatch(JSON.stringify(app.prompts[0]), /sentinel/i);
});

test("cutoff records late, failed-slot, disabled and unavailable inputs and recovery reuses the dated document", async t => {
  const fixture = { discovery: ["ready", "failed", "running", "disabled"] as Discovery[], ownEvidence: true, onto: false, wiki: "unavailable" as "unavailable" | "authored" };
  const app = await replay(t, fixture);
  const cutoff = morning + 3 * hour;
  const lastWait = await app.fire(cutoff - 1);
  assert.equal(lastWait.outcome, "deferred");
  assert.equal(lastWait.retryAt, cutoff);
  assert.equal(app.prompts.length, 0);
  await app.fire(cutoff);
  const partial = app.writes[0];
  assert.equal(partial.provenance.status, "incomplete");
  assert.match(partial.generatedBody, /calendar-discovery.*failed or was declined/);
  assert.match(partial.generatedBody, /planning-discovery.*no final result/);
  assert.match(partial.generatedBody, /follow-up-discovery.*disabled/);
  assert.match(partial.generatedBody, /Onto.*Coverage is unknown/);
  assert.match(partial.generatedBody, /Wiki: authored revision coverage is incomplete/);
  assert.doesNotMatch(JSON.stringify(app.prompts[0]), /foreign owner sentinel/i);
  assert.ok(!app.trace.some(call => call.input.id === "discovery-run-3"));

  fixture.discovery.fill("ready");
  fixture.wiki = "authored";
  fixture.onto = true;
  await app.fire(cutoff + 60_000);
  assert.equal(app.writes.length, 1);
  assert.equal(app.outcomes.length, 1);

  const recoverySlot = { ...occurrence, runId: "10000000-0000-4000-8000-000000000002" };
  await app.fire(cutoff + 60_000, recoverySlot);
  assert.deepEqual([app.writes[1].id, app.writes[1].revision, app.writes[1].provenance.date], ["brief-document", 1, oceanMorning.date]);
  await app.fire(cutoff + 60_000, recoverySlot);
  await app.fire(cutoff + 60_000, { ...occurrence, runId: "10000000-0000-4000-8000-000000000003" });
  await app.fire(morning + 24 * hour, { ...occurrence, runId: "10000000-0000-4000-8000-000000000004" });
  assert.equal(app.prompts.length, 2);
  assert.equal(app.writes.length, 2);
  assert.deepEqual(app.outcomes.slice(2), [
    { documentId: "brief-document", revision: 2, slug: partial.slug, date: oceanMorning.date, status: "incomplete", outcome: "unchanged" },
    { documentId: "brief-document", revision: 2, slug: partial.slug, date: oceanMorning.date, status: "incomplete", outcome: "unchanged" },
  ]);
  assert.ok(app.trace.filter(call => call.input.document === "DailyAppUpdates").every(call =>
    (call.input.variables as { date: string }).date === oceanMorning.yesterday));
});

test("successful empty coverage is evidence, whereas unavailable sources do not reach synthesis", async t => {
  const empty = await replay(t, { wiki: "empty", onto: "empty" });
  await empty.fire(morning);
  assert.match(empty.prompts[0].evidence.find(row => row.kind === "wiki-activity")?.text ?? "", /^0 authored Wiki revisions observed/);
  assert.match(empty.prompts[0].evidence.find(row => row.kind === "app-update")?.text ?? "", /Zero committed record revisions/);
  assert.ok(empty.prompts[0].notKnown.some(gap => gap.includes("no connected accounts")));
  assert.equal(empty.writes[0].provenance.status, "incomplete");

  const unavailable = await replay(t, { wiki: "unavailable" });
  await unavailable.fire(morning + 3 * hour);
  assert.deepEqual(unavailable.prompts, []);
  assert.deepEqual(unavailable.writes, []);
  assert.deepEqual(unavailable.outcomes, [{ date: oceanMorning.date, status: "failed", reason: "No saved evidence was available to write a brief from. Nothing was saved." }]);
});

test("a late source read remains unknown with other evidence and the Chicago fall-back day retains its 25-hour window", async t => {
  const app = await replay(t, { onto: true, wiki: "unavailable", dates: chicagoFallback });
  await app.fire(Date.parse(chicagoFallback.briefAt), { ...occurrence, scheduledFor: Date.parse(chicagoFallback.briefAt) });
  assert.equal(app.prompts[0].coversCompletedDay, chicagoFallback.yesterday);
  assert.ok(app.prompts[0].notKnown.includes("Wiki: authored revision coverage is incomplete."));
  assert.ok(!app.prompts[0].evidence.some(row => row.kind === "wiki-activity"));
  const completions = app.prompts[0].evidence.filter(row => row.kind === "completion");
  assert.deepEqual(completions.map(row => row.text), chicagoFallback.completions.slice(1, -1).map(row => row.title + " (stone)"));
  assert.deepEqual(app.trace.find(call => call.input.document === "WikiRevisionActivity")?.input.variables,
    { start: chicagoFallback.start, end: chicagoFallback.end, limit: 20 });
});

test("the handler refuses a foreign member before touching host data", async t => {
  const app = await replay(t);
  await assert.rejects(app.fire(morning, occurrence, { ...owner, userId: "other-member" }),
    error => error instanceof Response && error.status === 403);
  assert.deepEqual(app.trace, []);
});

test("the installed schedule route requires a trusted dispatch and returns the app's deferral", async t => {
  const scheduledFor = Date.now();
  const dispatchScope = { installationId: owner.installationId, organizationId: null, userId: owner.userId,
    packageHash: "test-package", phase: "schedule" as const, scheduleId: briefSchedule.id, expiresAt: scheduledFor + 60_000 };
  const calls: string[] = [];
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), owner.installationId, {
    workflowHost: scope => ({ async call(operation, input) {
      assert.deepEqual(scope, dispatchScope);
      calls.push((input as { document?: string }).document ?? operation);
      const scheduleFields = { timezone, enabled: true, createdBy: owner.userId, nextRunAt: scheduledFor,
        lastRunAt: null, lastRunId: null, lastOutcome: null };
      if (operation === "schedules") return { ok: true, value: [
        { ...briefSchedule, ...scheduleFields, cron: "0 5 * * *" },
        { ...briefSchedule, ...scheduleFields, id: "scheduled-discovery", workflowId: "forerunner-discovery", cron: "0 7 * * *", connectionId: "mail" },
      ] };
      if (operation === "platform.document" && (input as { document?: string }).document === "DailyAppUpdates") {
        return { ok: true, value: { data: { dailyAppUpdates: [onto] } } };
      }
      if (operation === "platform.document" && (input as { document?: string }).document === "Viewer") {
        return { ok: true, value: { viewer: { orgs: [] } } };
      }
      return { ok: false, status: 403, message: "Only dependency reads are expected before deferral" };
    } }),
  });
  t.after(() => app.dispose());
  const member = { userId: owner.userId, role: owner.role, organizationId: "", owner: owner.owner };
  const request = { method: "POST", body: { phase: "schedule", input: { ...occurrence, scheduledFor } } };
  const missing = await app.call(workflowHostPath, member, request);
  assert.equal(missing.status, 503);
  assert.deepEqual(calls, []);
  const response = await app.call(workflowHostPath, member, { ...request, workflowHost: dispatchScope });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const result = scheduleResult.parse(JSON.parse(body));
  assert.equal(result.outcome, "deferred");
  assert.ok(result.retryAt > scheduledFor);
  assert.deepEqual(calls, ["schedules", "DailyAppUpdates", "Viewer"]);
});


test("an Onto report in another zone is cited with its own period and does not delay an otherwise ready brief", async t => {
  const app = await replay(t, { onto: true, ontoTimezone: "America/Los_Angeles", wiki: "empty" });
  assert.equal((await app.fire(morning)).outcome, "started");
  assert.ok(app.prompts[0].evidence.some(row => row.kind === "app-update" && row.text.includes("America/Los_Angeles")));
  assert.ok(app.prompts[0].notKnown.some(gap => gap.includes("exact America/Chicago coverage is unknown")));
});

test("a clock retry still uses the stored deadline if its dispatch reports a later time", async t => {
  const app = await replay(t, { ownEvidence: true, pendingFor: morning, wiki: "unavailable" });
  const cutoff = morning + 3 * hour;
  assert.equal((await app.fire(cutoff, { ...occurrence, scheduledFor: cutoff })).outcome, "started");
  assert.equal(app.prompts[0].coversCompletedDay, oceanMorning.yesterday);
  assert.equal(app.writes[0].provenance.date, oceanMorning.date);
});

test("installed setup uses a known member timezone and leaves an unknown zone to the first member visit", async t => {
  const dispatchScope = { installationId: owner.installationId, organizationId: null, userId: owner.userId,
    packageHash: "test-package", phase: "interactive" as const, setup: true, expiresAt: Date.now() + 60_000 };
  const writes: unknown[] = [];
  let discoveryZone: string | undefined;
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), owner.installationId, {
    workflowHost: () => ({ async call(operation, input) {
      const schedule = { ...briefSchedule, enabled: true, timezone: "Asia/Tokyo", createdBy: owner.userId,
        cron: "0 5 * * *", nextRunAt: morning, lastRunAt: null, lastRunId: null, lastOutcome: null };
      if (operation === "schedules") return { ok: true, value: discoveryZone ? [
        { ...schedule, id: "discovery", workflowId: "forerunner-discovery", timezone: discoveryZone },
      ] : [] };
      assert.equal(operation, "schedule.save");
      writes.push(input);
      return { ok: true, value: schedule };
    } }),
  });
  t.after(() => app.dispose());
  const member = { userId: owner.userId, role: owner.role, organizationId: "", owner: owner.owner };
  const run = () => app.call("/api/internal/app-initialize", member, { method: "POST", body: {}, workflowHost: dispatchScope });
  const before = await run();
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { dailyBrief: "needs-timezone" });
  assert.deepEqual(writes, []);
  discoveryZone = "Asia/Tokyo";
  const after = await run();
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), { dailyBrief: "ready" });
  assert.deepEqual(writes, [{ workflow: "forerunner-daily-brief", cron: "0 5 * * *", timezone: "Asia/Tokyo", enabled: true, inputs: {}, ifUnset: true }]);
});
