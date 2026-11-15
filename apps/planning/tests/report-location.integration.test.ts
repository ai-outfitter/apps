import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import { reportHost } from "./fixtures/report-host";
import { readDailyReport, saveReportNote } from "../src/server/digest-wiki";
import { reportPeriodForDate } from "../src/server/report-period";

const actor: OrganizationIdentity = { userId: "bob", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "planning-a", role: "owner", canEdit: true };
const date = "2026-11-13", timezone = "America/Chicago";

test("a saved report is read straight from its recorded Wiki document; earlier reports are still found by name", async () => {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const { host, calls } = reportHost();
    const period = reportPeriodForDate(date, timezone);
    const saved = await saveReportNote(host, actor, { level: "organization", subject: "org", title: "Overview", period, content: { summary: "Captured." }, status: "complete", runId: "run", capturedAt: 1 }, db);
    calls.length = 0;
    const report = await readDailyReport(host, actor, { date, timezone }, db);
    assert.equal(report?.summary, "Captured.");
    assert.deepEqual(report?.reference, { installationId: "wiki", documentId: saved.documentId, revision: 1, slug: saved.slug });
    // One call: the document itself. No Wiki discovery and no page lookup.
    assert.deepEqual(calls.map(call => [call.operation, call.input.action]), [["actions.call", "graph.graphql"]]);
    calls.length = 0;
    // Without the recorded location the same report is found the earlier way.
    assert.equal((await readDailyReport(host, actor, { date, timezone }))?.summary, "Captured.");
    assert.ok(calls.some(call => call.operation === "actions.list"));
  } finally { client.close(); }
});
