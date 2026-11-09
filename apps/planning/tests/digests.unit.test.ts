import assert from "node:assert/strict";
import test from "node:test";
import { demoDigests, diffProject, hasChanges } from "../src/server/digests";
import type { Issue, Project } from "../src/server/schema";

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 6, 13);
const project = (overrides: Partial<Project> = {}): Project => ({
  id: "p1", installationId: "i1", name: "Launch", archived: false, state: "active", githubRepository: "",
  goals: "Ship it", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "",
  revision: 1, createdBy: "u1", updatedBy: "u1", createdAt: now - 72 * HOUR, updatedAt: now - 72 * HOUR, ...overrides,
});
let position = 0;
const issue = (id: string, overrides: Partial<Issue> = {}): Issue => ({
  id, installationId: "i1", projectId: "p1", title: id, description: "", category: "pebble", status: "todo",
  assigneeId: null, dueDate: null, position: position++, parentId: null,
  revision: 1, createdBy: "u1", updatedBy: "u1", createdAt: now - 72 * HOUR, updatedAt: now - 72 * HOUR, ...overrides,
});
const ids = (items: { id: string }[]) => items.map((item) => item.id);

test("a first digest reports the last 24 hours from record timestamps", async () => {
  const { changes } = await diffProject({
    project: project(),
    issues: [
      issue("old"),
      issue("new", { createdAt: now - HOUR, updatedAt: now - HOUR }),
      issue("shipped", { status: "done", updatedAt: now - 2 * HOUR }),
      issue("shipped-last-week", { status: "done", updatedAt: now - 100 * HOUR }),
      issue("started", { status: "in-progress", updatedAt: now - 3 * HOUR }),
    ],
    submissions: [],
  }, null, now);
  assert.deepEqual(ids(changes.added), ["new"]);
  assert.deepEqual(ids(changes.shipped), ["shipped"]);
  assert.deepEqual(ids(changes.started), ["started"]);
  assert.deepEqual(changes.totals, { open: 3, inProgress: 1, done: 2 });
  assert.equal(ids(changes.priorities)[0], "started", "in-progress work leads the priorities");
});

test("a later digest diffs against the previous snapshot, not timestamps", async () => {
  const before = await diffProject({
    project: project(),
    issues: [issue("a"), issue("b", { category: "stone" }), issue("c", { status: "done" }), issue("gone")],
    submissions: [],
  }, null, now - 24 * HOUR);
  const { changes } = await diffProject({
    project: project({ goals: "Ship it this week", revision: 2 }),
    issues: [
      // a shipped; b started; c reopened; d is new and already done; e is new.
      issue("a", { status: "done", revision: 2, updatedAt: now - HOUR }),
      issue("b", { category: "stone", status: "in-progress", revision: 2 }),
      issue("c", { status: "todo", revision: 2 }),
      issue("d", { status: "done", createdAt: now - HOUR }),
      issue("e"),
    ],
    submissions: [{ id: "s1", accepted: null, createdAt: now - HOUR }],
  }, before.snapshot, now);
  assert.deepEqual(ids(changes.shipped), ["a", "d"]);
  assert.deepEqual(ids(changes.started), ["b"]);
  assert.deepEqual(ids(changes.reopened), ["c"]);
  assert.deepEqual(ids(changes.added), ["d", "e"]);
  assert.deepEqual(ids(changes.removed), ["gone"]);
  assert.deepEqual(changes.documents, ["Goals"]);
  assert.deepEqual(changes.delivery, { submitted: 1, accepted: 0 });
  assert.ok(hasChanges(changes));
});

test("nothing new since the last digest is not news", async () => {
  const records = { project: project(), issues: [issue("a"), issue("b", { status: "in-progress" })], submissions: [] };
  const first = await diffProject(records, null, now - 24 * HOUR);
  const { changes } = await diffProject(records, first.snapshot, now);
  assert.equal(hasChanges(changes), false);
  assert.deepEqual(ids(changes.priorities), ["b", "a"], "priorities are still reported");
});

test("snapshots keep document fingerprints, never document text", async () => {
  const { snapshot } = await diffProject({ project: project({ goals: "A secret plan" }), issues: [], submissions: [] }, null, now);
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
});

test("the demo digest is synthetic and complete", () => {
  const { digests } = demoDigests("p1");
  assert.equal(digests.length, 1);
  assert.ok(digests[0].summary);
  assert.ok(hasChanges(digests[0].changes));
});
