import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { reportSource, readDayReview } from "../src/server/day-review";
import { reviewPeriod, shiftDate } from "../src/server/review-period";
import { createItem, updateItem, deleteItem } from "../src/server/items";
import { itemCompletions } from "../src/server/schema";

const now = Date.parse("2026-11-11T14:00:00Z");
const identity: AppIdentity = { userId: "a", installationId: "mine", owner: { kind: "user", id: "a" }, role: "owner", canEdit: true };
const period = reviewPeriod({}, now);
const report = () => ({ period, status: "complete", summary: "Saved observations.", reference: { slug: "daily-test", revision: 3 }, dependencies: [{ summary: { repositoryEvidence: { repositories: [{ pullRequests: [{ title: "Ship a customer outcome", number: 12, url: "https://github.com/example/repo/pull/12", mergedAt: "2026-11-10T16:00:00Z" }], omittedPullRequestCount: 2 }] } } }] });

test("completed calendar days and week navigation honor local midnight and DST", () => {
  assert.equal(period.date, "2026-11-10");
  assert.equal(shiftDate(period.date, -7), "2026-11-03");
  assert.equal(reviewPeriod({ date: "2026-03-08" }, now).end - reviewPeriod({ date: "2026-03-08" }, now).start, 23 * 3_600_000);
  assert.equal(reviewPeriod({ date: "2026-11-01" }, now).end - reviewPeriod({ date: "2026-11-01" }, now).start, 25 * 3_600_000);
  assert.throws(() => reviewPeriod({ date: "2026-11-11" }, now), (error: unknown) => error instanceof Response && error.status === 400);
  assert.throws(() => reviewPeriod({ timezone: "not/a-zone" }, now), (error: unknown) => error instanceof Response && error.status === 400);
});

test("saved report observations retain date, source revision and coverage instead of inventing completions", () => {
  const captured = report();
  captured.dependencies.push(...captured.dependencies);
  const result = reportSource(captured, "sunny", "Sunny", period);
  assert.equal(result.status, "complete");
  assert.equal(result.work.length, 1);
  assert.equal(result.work[0].kind, "Merged pull request");
  assert.equal(result.more, true);
  assert.equal(result.href, "/o/sunny/wiki-map/p/daily-test?revision=3");
  assert.equal(reportSource(null, "sunny", "Sunny", period).status, "missing");
  assert.equal(reportSource({ ...captured, period: { ...period, date: "2026-11-09" } }, "sunny", "Sunny", period).status, "unavailable");
  captured.dependencies[0].summary.repositoryEvidence.repositories[0].pullRequests[0].url = "https://untrusted.example/pull";
  assert.equal(reportSource(captured, "sunny", "Sunny", period).work.length, 0);
});

test("completed issue observations retain their recorded time without claiming a reconstructed transition", () => {
  const captured = { ...report(), dependencies: [{ projectId: "project", summary: { completedIssues: [{ id: "issue", title: "Accepted launch review", observedAt: period.start + 100 }], omittedIssueObservations: 2 } }] };
  const result = reportSource(captured, "artera", "Artera", period);
  assert.equal(result.work[0].kind, "Completed issue observation");
  assert.equal(result.work[0].url, "/o/artera/planning/projects/project");
  assert.equal(result.more, true);
});

async function database() {
  const client = createClient({ url: ":memory:" }); const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}
const unavailableHost = { call: async () => { throw new Response("Unavailable", { status: 503 }); } } as unknown as WorkflowHost<"interactive">;

test("completion events are atomic, private, and survive edits, reopening and deletion", async context => {
  const { client, db } = await database();
  let clock = Date.parse("2026-11-04T16:00:00Z"); context.mock.method(Date, "now", () => clock);
  const fields = { category: "stone", title: "Finish onboarding", description: "", status: "done", dueDate: null, parentId: null };
  try {
    let item = await createItem(db, identity, fields);
    clock = Date.parse("2026-11-05T16:00:00Z");
    item = await updateItem(db, identity, item.id, { ...fields, title: "Edited after completion", revision: item.revision });
    assert.equal((await db.select().from(itemCompletions)).length, 1);
    item = await updateItem(db, identity, item.id, { ...fields, status: "todo", revision: item.revision });
    clock = Date.parse("2026-11-10T17:00:00Z");
    item = await updateItem(db, identity, item.id, { ...fields, revision: item.revision });
    await assert.rejects(updateItem(db, identity, item.id, { ...fields, revision: item.revision - 1 }));
    const history = await db.select().from(itemCompletions);
    assert.equal(history.length, 2);
    assert.equal(history[0].title, "Finish onboarding");
    assert.equal(history[0].completedAt, Date.parse("2026-11-04T16:00:00Z"));
    await deleteItem(db, identity, item.id, { revision: item.revision });
    const previousWeek = await readDayReview(db, identity, unavailableHost, { date: "2026-11-04" }, now);
    assert.equal(previousWeek.completions.length, 1);
    assert.equal(previousWeek.completions[0].available, false);
    assert.equal(previousWeek.completions[0].title, "Finish onboarding");
    const other = await readDayReview(db, { ...identity, userId: "b" }, unavailableHost, { date: "2026-11-04" }, now);
    assert.deepEqual(other.completions, []);
    const otherInstallation = await readDayReview(db, { ...identity, installationId: "other" }, unavailableHost, {}, now);
    assert.deepEqual(otherInstallation.completions, []);
  } finally { client.close(); }
});

test("organization sources use live membership, saved order and independent failures without starting work", async () => {
  const { client, db } = await database();
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const host = { async call(operation: string, input: Record<string, unknown>) {
    calls.push({ operation, input });
    if (operation === "entities.types") return [{ installationId: "planning", template: "planning", type: "portfolio-priority", collection: "portfolio-priorities" }];
    if (operation === "entities.get") return { ref: { installationId: "planning", type: "portfolio-priority", id: "organizations" }, title: "Order", revision: 1, references: [], attributes: { items: ["sunny", "keystone", "artera", "revoked"] } };
    if (operation === "actions.call") { assert.equal(input.readOnly, true); return { data: { dailyReport: report() } }; }
    assert.equal(operation, "platform.document");
    if (!input.variables) return { viewer: { orgs: ["artera", "keystone", "sunny"].map(slug => ({ slug, name: slug, appSlugs: ["planning"] })) } };
    const slug = (input.variables as { slugs: string[] }).slugs[0];
    assert.notEqual(slug, "revoked");
    if (slug === "keystone") throw new Response("Source unavailable", { status: 503 });
    return { viewer: { orgs: [{ slug, dailyReports: { nodes: [{ report: slug === "artera" ? null : report() }], pageInfo: { hasNextPage: false } } }] } };
  } } as unknown as WorkflowHost<"interactive">;
  try {
    const result = await readDayReview(db, identity, host, {}, now);
    assert.deepEqual(result.organizations.map(row => [row.scope, row.status]), [["sunny", "complete"], ["keystone", "unavailable"], ["artera", "missing"]]);
    assert.equal(result.organizations[0].work.length, 1);
    assert.ok(calls.every(call => !/start|save|create|mutate/.test(call.operation)));
    assert.equal(result.previousWeek, "2026-11-03");
  } finally { client.close(); }
});
