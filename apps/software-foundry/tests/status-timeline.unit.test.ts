import assert from "node:assert/strict";
import test from "node:test";
import { homeCardBody } from "@ai-outfitter/app-sdk/home-cards";
import type { OperationOutput } from "@ai-outfitter/app-sdk/workflow-host";
import { runState, statusTimeline, timelineSummary } from "../src/server/home-cards";

type Activity = OperationOutput<"workflow.activity">["items"][number];
const now = Date.UTC(2026, 10, 2, 15);
const hour = 60 * 60_000;
const run = (id: string, status: Activity["status"], repository: string, updatedAt: number, completedSteps: string[] = []): Activity => ({
  id, workflowId: "issue-to-merge-actions-ci", status, createdBy: "member", visibility: "organization",
  createdAt: updatedAt - hour, updatedAt, completedSteps,
  inputs: { "triage.inputs.event": { repository: { full_name: repository }, issue: { number: 7, title: `Work ${id}` } } },
});
const landed = ["triage", "implement", "validate", "review", "validate-final", "review-final", "land"];

test("a run's state follows its furthest completed step", () => {
  const at = (status: Activity["status"], steps: string[]) => runState(run("r", status, "a/b", now, steps));
  assert.deepEqual(at("complete", landed), { state: "shipped" });
  assert.deepEqual(at("complete", ["triage"]), { state: "needs-you", detail: "triage needs more detail" }, "complete without landing is not shipped");
  assert.equal(at("failed", ["triage"]).state, "needs-you");
  assert.deepEqual(at("running", []), { state: "planning", detail: "triage agent" });
  assert.deepEqual(at("running", ["triage"]), { state: "in-progress", detail: "builder agent" });
  assert.deepEqual(at("running", ["triage", "implement", "validate"]), { state: "agent-review", detail: "reviewer agent" });
  assert.deepEqual(at("running", ["triage", "implement", "validate", "review"]), { state: "in-progress", detail: "fixes and final checks" });
  // repair is skipped when review approved; the furthest step still decides
  assert.deepEqual(at("running", ["triage", "implement", "validate", "review", "validate-final"]), { state: "agent-review", detail: "final review" });
  assert.deepEqual(at("running", landed.slice(0, -1)), { state: "in-progress", detail: "landing" });
});

test("the timeline groups this week's work by day, then by project priority, and stays inside the card contract", () => {
  const projects = [
    { id: "p-high", name: "Foundry", repositories: ["alpha/foundry"] },
    { id: "p-low", name: "Platform", repositories: ["alpha/web"] },
  ];
  const runs = [
    run("web-today", "complete", "Alpha/Web", now - hour, landed),
    run("foundry-today", "running", "alpha/foundry", now - 2 * hour, ["triage", "implement", "validate"]),
    run("stray", "running", "beta/other", now - 3 * hour),
    run("failed-yesterday", "failed", "alpha/web", now - 24 * hour),
    run("old", "complete", "alpha/web", now - 9 * 24 * hour, landed),
  ];
  const body = statusTimeline(runs, projects, true, now);
  assert.ok(homeCardBody.safeParse(body).success);
  const [node] = body;
  assert.ok(node.kind === "timeline");
  assert.equal(node.summary, "1 change shipped this week, 2 in flight (1 with reviewer agents) and 1 needs a person.");
  assert.deepEqual(node.groups.map((g) => [g.label, g.projects.map((p) => p.title)]), [
    ["Today", ["Foundry", "Platform", "Other work"]],
    ["Yesterday", ["Platform"]],
  ]);
  const failed = node.groups[1].projects[0].items[0];
  assert.deepEqual(failed, { id: "failed-yesterday", title: "Work failed-yesterday", state: "needs-you", detail: "stopped before landing",
    link: { path: "/workflows?workflow=issue-to-merge-actions-ci&run=failed-yesterday" }, verb: "review" });
  const members = statusTimeline(runs, projects, false, now);
  assert.ok(members[0].kind === "timeline" && members[0].groups.every((g) => g.projects.every((p) => p.items.every((i) => !i.link))),
    "members are not linked to editor-only run pages");
  assert.equal(statusTimeline([runs[4]], projects, true, now)[0].kind, "empty");
});

test("a busy day keeps its eleven most important projects and folds the rest into Other work", () => {
  const projects = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, repositories: [`o/r${i}`] }));
  const runs = [run("stray", "running", "x/y", now - hour), ...projects.map((p, i) => run(`run-${i}`, "running", `o/r${i}`, now - hour))];
  const body = statusTimeline(runs, projects, true, now);
  assert.ok(homeCardBody.safeParse(body).success);
  const [node] = body;
  assert.ok(node.kind === "timeline");
  const titles = node.groups[0].projects.map((p) => p.title);
  assert.deepEqual(titles, [...projects.slice(0, 11).map((p) => p.name), "Other work"]);
  assert.deepEqual(node.groups[0].projects.at(-1)?.items.map((i) => i.id).sort(), ["run-11", "run-12", "run-13", "stray"]);
});

test("a run read twice keeps its newer copy, and long issue titles fit the card", () => {
  const long = { ...run("r", "running", "a/b", now - 2 * hour), inputs: { "triage.inputs.event": { repository: "a/b", issue: { title: "x".repeat(200) } } } };
  const body = statusTimeline([long, run("r", "complete", "a/b", now - hour, landed)], [], true, now);
  assert.ok(homeCardBody.safeParse(body).success);
  assert.ok(body[0].kind === "timeline");
  assert.deepEqual(body[0].groups.flatMap((g) => g.projects.flatMap((p) => p.items.map((i) => i.state))), ["shipped"]);
  const [clipped] = statusTimeline([long], [], true, now);
  assert.ok(clipped.kind === "timeline");
  assert.equal(clipped.groups[0].projects[0].items[0].title.length, 120);
});

test("the summary reads naturally for quiet weeks", () => {
  assert.equal(timelineSummary([]), "Nothing shipped this week.");
  assert.equal(timelineSummary(["planning"]), "Nothing shipped this week and 1 in flight.");
});
