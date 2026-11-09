import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import { codeChangeType, deliversType, linkProjectChanges, mergedIntoType } from "../src/server/code-changes";
import * as planning from "../src/server/planning";

const editor: OrganizationIdentity = { userId: "bob", organizationId: "org", owner: { kind: "organization", id: "org" }, installationId: "planning", role: "owner", canEdit: true };
const project = { name: "", githubRepository: "", goals: "", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "" };
const record = (id: string, attributes: Record<string, unknown>, title = id, references: unknown[] = []) => ({ ref: { installationId: "wiki", type: "node", id }, revision: 1, title, attributes, references });
const pull = (number: number, title: string) => ({ number, title, url: `https://github.com/org/webapp/pull/${number}`, mergedAt: "2026-11-05T12:00:00Z", author: "ada" });

/** Two projects: Digests owns a path of the webapp repository; Billing shares the whole repository. */
async function setup() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const digests = await planning.createProject(db, editor, { ...project, name: "Digests", goals: "Daily project digests." });
  const billing = await planning.createProject(db, editor, { ...project, name: "Billing", goals: "Invoices and plans." });
  const graph = {
    wiki: { installationId: "wiki" },
    types: [record("t-project", { name: "Project" }), record("t-repo", { name: "Repository" }), record("t-source", { name: "source_in" }), record("t-change", { name: "CodeChange" })],
    nodes: [
      record("w-digests", { typeId: "t-project" }, "Digests", [{ installationId: "planning", type: "project", id: digests.id }]),
      record("w-billing", { typeId: "t-project" }, "Billing", [{ installationId: "planning", type: "project", id: billing.id }]),
      record("w-repo", { typeId: "t-repo", website: "https://github.com/org/webapp" }, "webapp"),
      record("w-known", { typeId: "t-change", website: pull(1, "").url }, "Already linked"),
    ],
    edges: [
      record("e1", { typeId: "t-source", fromId: "w-digests", toId: "w-repo", properties: { path: "catalog/apps/planning" } }),
      record("e2", { typeId: "t-source", fromId: "w-billing", toId: "w-repo", properties: {} }),
    ],
  };
  return { client, db, digests, billing, graph };
}

type Input = Record<string, any>;
function host(projects: { digests: string; billing: string }) {
  const calls: { operation: string; input: Input }[] = [];
  const commits = (input: Input) => {
    // The path-scoped read (Digests) sees #2; the whole repository (Billing) sees #1, #2 and #3.
    const pulls = input.input.path ? [pull(2, "Show digests on the project page")] : [pull(1, "Old"), pull(2, "Show digests on the project page"), pull(3, "Invoice totals")];
    return { ref: "main", more: false, commits: pulls.map((item, index) => ({ sha: String(index).repeat(40), headline: item.title, committedAt: item.mergedAt, url: "https://github.com/org/webapp/commit/x", author: "ada", pullRequests: [item] })) };
  };
  const attribute = (input: Input) => {
    const to = String(input.data.pullRequest.title).startsWith("Show digests") ? projects.digests : projects.billing;
    return { output: { projects: [{ projectId: to, confidence: 0.8, reason: `The title is about ${to === projects.digests ? "digests" : "invoices"}.` }] } };
  };
  const wiki = (input: Input) => {
    if (input.action === "batch.open") return { batch: { id: "11111111-1111-4111-8111-111111111111", state: "open" } };
    if (input.input.operationName === "StageChanges") return { data: { stageChanges: { id: "b", state: "open", counts: {} } } };
    return { data: { submitBatch: { id: "b", state: "awaiting_review", reviewBy: null, counts: {}, operations: [] } } };
  };
  const handlers: Record<string, (input: Input) => unknown> = {
    "workflow.start": (input) => ({ id: input.id, workflow: input.workflow, created: true }),
    "workflow.collect": () => ({ run: {}, steps: [] }),
    snapshot: () => ({ connections: [{ id: "gh", provider: "github", owner: "organization", operations: ["commits.list"] }] }),
    "repository.request": () => ({ id: 30 }),
    "connector.execute": commits,
    "inference.generate": attribute,
    "actions.call": wiki,
  };
  const double = {
    async call(operation: string, input: Input) {
      calls.push({ operation, input });
      const handler = handlers[operation];
      if (!handler) throw new Error(`Unexpected ${operation}`);
      return handler(input);
    },
  };
  return { calls, host: double as never };
}

test("merged pull requests are staged as one batch, linked to the projects they delivered for with a reason", async () => {
  const { client, db, digests, billing, graph } = await setup();
  try {
    const { calls, host: double } = host({ digests: digests.id, billing: billing.id });
    const result = await linkProjectChanges(db, double, editor, {}, async () => graph as never);
    assert.equal(result.pullRequests, 2, "#1 is already in the Wiki");
    assert.equal(result.state, "awaiting_review");
    const staged = calls.filter((call) => call.input?.input?.operationName === "StageChanges").flatMap((call) => call.input.input.variables.input.proposals);
    const nodes = staged.filter((item: any) => item.operation.attributes.typeId === codeChangeType);
    assert.deepEqual(nodes.map((item: any) => item.operation.attributes.website), [pull(2, "").url, pull(3, "").url]);
    assert.equal(staged.filter((item: any) => item.operation.attributes.typeId === mergedIntoType).length, 2);
    const delivers = staged.filter((item: any) => item.operation.attributes.typeId === deliversType);
    assert.deepEqual(delivers.map((item: any) => item.operation.attributes.toId), ["w-digests", "w-billing"]);
    // #3 was found under Billing alone: linked by that fact. #2 is shared, so the model chose and explained.
    assert.match(delivers[1].reason, /no other project links it/);
    assert.equal(delivers[1].confidence, 0.9);
    assert.equal(delivers[0].reason, "The title is about digests.");
    assert.equal(calls.filter((call) => call.operation === "inference.generate").length, 1);
    assert.ok(staged.every((item: any) => item.evidence[0].provider === "github" && item.evidence[0].uri.startsWith("https://github.com/org/webapp/pull/")));
    const open = calls.find((call) => call.input?.action === "batch.open");
    assert.deepEqual(open?.input.input.policy, { kind: "confidence", threshold: 0.9, version: "planning-code-changes-1" });
    assert.deepEqual(calls.at(-1)?.input.value, { pullRequests: 2, proposals: staged.length, skipped: 0 });
  } finally {
    client.close();
  }
});

test("only editors link changes, and nothing new opens no batch", async () => {
  const { client, db, digests, billing, graph } = await setup();
  try {
    const { calls, host: double } = host({ digests: digests.id, billing: billing.id });
    await assert.rejects(linkProjectChanges(db, double, { ...editor, role: "member", canEdit: false }, {}, async () => graph as never), (error) => error instanceof Response && error.status === 403);
    const empty = { ...graph, edges: [] };
    const result = await linkProjectChanges(db, double, editor, { projectId: digests.id }, async () => empty as never);
    assert.deepEqual({ ...result, runId: "" }, { runId: "", batchId: null, state: null, pullRequests: 0, proposals: 0, skipped: 0, unread: [] });
    assert.ok(!calls.some((call) => call.input?.action === "batch.open"));
  } finally {
    client.close();
  }
});
