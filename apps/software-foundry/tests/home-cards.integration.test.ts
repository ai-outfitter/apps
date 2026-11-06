import assert from "node:assert/strict";
import test from "node:test";
import { homeCardCatalog, homeCardReadResult } from "@ai-outfitter/app-sdk/home-cards";
import type { OperationInput, OperationOutput } from "@ai-outfitter/app-sdk/workflow-host";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";

const cards = "/api/internal/home-cards/v1/";
const artifact = appArtifact(new URL("..", import.meta.url), "operational");
const owner: Member = { userId: "owner", organizationId: "alpha", role: "owner" };
const member: Member = { userId: "member", organizationId: "alpha", role: "member" };
type Activity = OperationOutput<"workflow.activity">["items"][number];

test("Foundry cards show bounded active work, elapsed time and quieter shipped history through the scoped host", async () => {
  const now = Date.now();
  let active: Activity[] = [];
  let shipped: Activity[] = [];
  const calls: { userId: string; organizationId: string | null; input: OperationInput<"workflow.activity"> }[] = [];
  const app = await appWorker("software-foundry", artifact, "foundry", {
    workflowHost: (scope) => ({
      async call(operation, input) {
        assert.equal(operation, "workflow.activity", "card reads never call a connector or mutate a workflow");
        const query = input as OperationInput<"workflow.activity">;
        calls.push({ userId: scope.userId, organizationId: scope.organizationId, input: query });
        const rows = query.statuses?.includes("running") ? active : shipped;
        return { ok: true, value: { total: rows.length, items: rows.slice(0, query.limit) } };
      },
    }),
  });
  const call = (operation: string, who: Member, body?: unknown) => app.call(`${cards}${operation}`, who, {
    ...(body === undefined ? {} : { method: "POST", body }),
    workflowHost: { installationId: app.installationId, organizationId: who.organizationId, userId: who.userId,
      packageHash: "test", phase: "interactive", expiresAt: Date.now() + 60_000 },
  });
  const read = async (who: Member, size: string, cardId = "projects") => {
    const response = await call("read", who, { cardId, size });
    assert.equal(response.status, 200, await response.clone().text());
    const result = homeCardReadResult.parse(await response.json());
    assert.equal(result.status, "ready");
    if (result.status !== "ready") throw new Error("Expected ready card");
    return result.body;
  };
  const row = (index: number, status: "running" | "complete"): Activity => ({
    id: `${status}-${index}`, workflowId: "issue-to-merge-actions-ci", status, createdBy: "member", visibility: "organization",
    createdAt: now - 65 * 60_000, updatedAt: now - (status === "complete" ? 2 * 60 * 60_000 : 0),
    inputs: { "triage.inputs.event": { repository: { full_name: "alpha/web" }, issue: { number: index + 100, title: `Work ${index}` } } },
  });
  try {
    assert.equal((await app.call(`${cards}catalog`)).status, 401);
    const catalog = homeCardCatalog.parse(await (await call("catalog", member)).json());
    assert.deepEqual(catalog.cards.map(({ cardId, sizes, actionIds }) => ({ cardId, sizes, actionIds })),
      [{ cardId: "projects", sizes: ["small", "medium", "large"], actionIds: [] }, { cardId: "status", sizes: ["large"], actionIds: [] }]);
    const empty = await read(member, "medium");
    assert.deepEqual(empty, [
      { kind: "metric", label: "Active work", value: 0, detail: "No recently shipped work" },
      { kind: "text", text: "No Foundry work is active.", tone: "neutral", emphasis: "muted" },
    ]);
    active = Array.from({ length: 5 }, (_, i) => row(i, "running"));
    shipped = Array.from({ length: 4 }, (_, i) => row(i + 10, "complete"));
    for (const [size, activeCount, shippedCount] of [["small", 1, 1], ["medium", 3, 1], ["large", 3, 3]] as const) {
      calls.length = 0;
      const body = await read(member, size);
      assert.deepEqual(body[0], { kind: "metric", label: "Active work", value: 5, detail: "4 shipped recently" });
      const lists = body.filter((node) => node.kind === "list");
      assert.deepEqual(lists.map((list) => [list.label, list.items.length]), [["Active work", activeCount], ["Recently shipped", shippedCount]]);
      assert.deepEqual(lists[0].items[0], { id: "running-0", title: "Work 0", subtitle: "alpha/web #100", meta: "1h" });
      assert.equal(lists[1].items[0].meta, "2h ago");
      assert.ok(lists.every((list) => list.items.every((item) => !item.link)), "members are not linked to editor-only run pages");
      assert.deepEqual(calls.map(({ userId, organizationId }) => ({ userId, organizationId })),
        [{ userId: "member", organizationId: "alpha" }, { userId: "member", organizationId: "alpha" }]);
      assert.ok(calls.every(({ input }) => input.slots?.includes("triage.inputs.event") && input.workflows?.includes("issue-to-merge-actions-ci")));
    }
    const editor = await read(owner, "medium");
    const activeList = editor.find((node) => node.kind === "list" && node.label === "Active work");
    assert.ok(activeList?.kind === "list");
    assert.deepEqual(activeList.items[0].link, { path: "/workflows?workflow=issue-to-merge-actions-ci&run=running-0" });
    // The status timeline reads running and finished work separately, with step progress, and
    // asks only for input slots (the host refuses output slots).
    calls.length = 0;
    shipped = shipped.map((run, i) => ({ ...run, completedSteps: i ? ["triage", "land"] : ["triage"] }));
    const [timeline] = await read(owner, "large", "status");
    assert.ok(timeline.kind === "timeline");
    assert.deepEqual(calls.map(({ input }) => [input.statuses, input.steps, input.limit]), [[["running"], true, 20], [["complete", "failed"], true, 20]]);
    assert.ok(calls.every(({ input }) => input.slots?.every((slot) => slot.includes(".inputs."))));
    assert.equal(timeline.summary, "3 changes shipped this week, 5 in flight and 1 needs a person.");
    // Finished rows are two hours old, so they may fall on yesterday's UTC day.
    assert.deepEqual([...new Set(timeline.groups.flatMap((g) => g.projects.map((p) => p.title)))], ["Other work"]);
    assert.equal(timeline.groups.flatMap((g) => g.projects.flatMap((p) => p.items)).length, 9);
    assert.equal(timeline.groups[0].projects[0].items[0].link?.path, "/workflows?workflow=issue-to-merge-actions-ci&run=running-0");
    assert.equal((await call("read", member, { cardId: "other", size: "small" })).status, 404);
    assert.equal((await call("read", member, { cardId: "projects", size: "huge" })).status, 400);
    assert.equal((await call("action", member, { cardId: "projects", actionId: "run", input: {}, revision: 1 })).status, 404);
  } finally {
    await app.dispose();
  }
});
