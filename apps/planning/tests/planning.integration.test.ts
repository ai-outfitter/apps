import { encodeMemberIds, memberIdsHeader } from "@ai-outfitter/app-sdk/members";
import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import type { OrganizationIdentity } from "@ai-outfitter/app-sdk/server";
import * as planning from "../src/server/planning";
import { issues } from "../src/server/schema";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fileURLToPath } from "node:url";
const alice: OrganizationIdentity = {
  userId: "alice",
  organizationId: "org",
  owner: { kind: "organization" as const, id: "org" },
  installationId: "planning-a",
  role: "member",
  canEdit: false,
};
const bob = { ...alice, userId: "bob", role: "owner", canEdit: true },
  other = { ...alice, installationId: "planning-b" };
const status = (code: number) => (error: unknown) =>
  error instanceof Response && error.status === code;
async function setup() {
  const client = createClient({ url: ":memory:" }),
    db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return { client, db };
}
const draft = (
  projectId: string,
  title = "Choose the launch outcome",
  category: "stone" | "pebble" | "sand" = "stone",
  parentId: string | null = null,
) => ({
  projectId,
  title,
  category,
  parentId,
  description: "",
  status: "todo" as const,
  assigneeId: null,
  dueDate: null,
});

test("Planning shares organization projects and issues, while installations and revisions remain isolated", async () => {
  const { client, db } = await setup();
  try {
    const project = await planning.createProject(db, alice, {
      name: "Launch",
      goals: "Reduce triage time",
      userStories: "As a member I can choose next work",
      pressRelease: "We focus on valuable work",
      demoInstructions: "Create and complete an issue",
      demoResults: "Not yet verified",
    });
    const issue = await planning.createIssue(db, alice, draft(project.id));
    assert.equal((await planning.listPlanning(db, bob)).issues[0].id, issue.id);
    assert.equal((await planning.listPlanning(db, other)).issues.length, 0);
    await assert.rejects(
      planning.updateIssue(db, other, issue.id, {
        ...draft(project.id),
        revision: 1,
      }),
      status(409),
    );
    const updated = await planning.updateIssue(db, bob, issue.id, {
      ...draft(project.id, "Reviewed"),
      revision: 1,
      status: "done",
    });
    assert.equal(updated.status, "done");
    await assert.rejects(
      planning.updateIssue(db, alice, issue.id, {
        ...draft(project.id),
        revision: 1,
      }),
      status(409),
    );
    await planning.updateProject(db, bob, project.id, {
      name: "Launch clarified",
      revision: 1,
    });
    await assert.rejects(
      planning.updateProject(db, alice, project.id, {
        name: "Overwrite",
        revision: 1,
      }),
      status(409),
    );
    await planning.deleteIssue(db, bob, issue.id, { revision: updated.revision });
    await planning.deleteProject(db, alice, project.id, { revision: 2 });
    assert.equal((await planning.listPlanning(db, alice)).projects.length, 0);
  } finally {
    client.close();
  }
});

test("independent categories can nest, but database constraints reject cycles, cross-project links and deletion of parents", async () => {
  const { client, db } = await setup();
  try {
    const p = await planning.createProject(db, alice, { name: "One" }),
      q = await planning.createProject(db, alice, { name: "Two" }),
      foreign = await planning.createProject(db, other, { name: "Foreign" });
    const sand = await planning.createIssue(
        db,
        alice,
        draft(p.id, "Parent sand", "sand"),
      ),
      stone = await planning.createIssue(
        db,
        alice,
        draft(p.id, "Child stone", "stone", sand.id),
      );
    await assert.rejects(
      planning.updateIssue(db, alice, sand.id, {
        ...draft(p.id, "Cycle", "sand", stone.id),
        revision: 1,
      }),
      status(409),
    );
    await assert.rejects(
      planning.createIssue(
        db,
        alice,
        draft(q.id, "Wrong project", "pebble", sand.id),
      ),
      status(409),
    );
    await assert.rejects(
      planning.createIssue(db, alice, draft(foreign.id)),
      status(409),
    );
    await assert.rejects(
      planning.deleteIssue(db, alice, sand.id, { revision: 1 }),
      status(409),
    );
    await assert.rejects(
      planning.deleteProject(db, alice, p.id, { revision: 1 }),
      status(409),
    );
    await assert.rejects(
      db
        .update(issues)
        .set({ parentId: stone.id })
        .where(eq(issues.id, sand.id)),
    );
    await assert.rejects(
      db.update(issues).set({ projectId: q.id }).where(eq(issues.id, sand.id)),
    );
    await planning.updateIssue(db, alice, stone.id, {
      ...draft(p.id, "Detached", "stone"),
      revision: 1,
    });
    await planning.deleteIssue(db, alice, sand.id, { revision: 1 });
  } finally {
    client.close();
  }
});

test("reorder is atomic across stale, incomplete, duplicate and foreign lists", async () => {
  const { client, db } = await setup();
  try {
    const p = await planning.createProject(db, alice, { name: "Order" }),
      a = await planning.createIssue(db, alice, draft(p.id, "A")),
      b = await planning.createIssue(db, alice, draft(p.id, "B"));
    for (const items of [
      [{ id: a.id, revision: 1 }],
      [
        { id: a.id, revision: 1 },
        { id: a.id, revision: 1 },
      ],
      [
        { id: b.id, revision: 2 },
        { id: a.id, revision: 1 },
      ],
    ])
      await assert.rejects(
        planning.reorderIssues(db, alice, {
          projectId: p.id,
          category: "stone",
          items,
        }),
        status(409),
      );
    assert.deepEqual(
      (await planning.listPlanning(db, alice)).issues.map((i) => i.title),
      ["A", "B"],
    );
    await planning.reorderIssues(db, bob, {
      projectId: p.id,
      category: "stone",
      items: [
        { id: b.id, revision: 1 },
        { id: a.id, revision: 1 },
      ],
    });
    assert.deepEqual(
      (await planning.listPlanning(db, alice)).issues.map((i) => i.title),
      ["B", "A"],
    );
  } finally {
    client.close();
  }
});

test("moving an issue to another category or project appends it to the destination list atomically", async () => {
  const { client, db } = await setup();
  try {
    const p = await planning.createProject(db, alice, { name: "Moves" }),
      q = await planning.createProject(db, alice, { name: "Elsewhere" }),
      a = await planning.createIssue(db, alice, draft(p.id, "A")),
      b = await planning.createIssue(db, alice, draft(p.id, "B", "pebble")),
      c = await planning.createIssue(db, alice, draft(p.id, "C", "pebble"));
    assert.deepEqual([a.position, b.position, c.position], [0, 0, 1]);
    const moved = await planning.updateIssue(db, alice, a.id, {
      ...draft(p.id, "A", "pebble"),
      revision: a.revision,
    });
    assert.equal(moved.position, 2);
    assert.equal(moved.revision, a.revision + 1);
    const retitled = await planning.updateIssue(db, alice, b.id, {
      ...draft(p.id, "B edited", "pebble"),
      revision: b.revision,
    });
    assert.equal(retitled.position, 0);
    await assert.rejects(
      planning.updateIssue(db, alice, a.id, { ...draft(p.id, "A", "sand"), revision: a.revision }),
      status(409),
    );
    const child = await planning.createIssue(db, alice, draft(p.id, "Child", "sand", c.id));
    await assert.rejects(
      planning.updateIssue(db, alice, c.id, { ...draft(q.id, "C", "pebble"), revision: c.revision }),
      status(409),
    );
    const across = await planning.updateIssue(db, alice, child.id, {
      ...draft(q.id, "Child", "stone"),
      revision: child.revision,
    });
    assert.equal(across.position, 0);
    const pebbles = (await planning.listPlanning(db, alice)).issues.filter(
      (i) => i.projectId === p.id && i.category === "pebble",
    );
    assert.deepEqual(
      pebbles.map((i) => [i.title, i.position]),
      [["B edited", 0], ["C", 1], ["A", 2]],
    );
  } finally {
    client.close();
  }
});

test("Planning validates assignees in its own Worker using the live generic directory context", async () => {
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    const project = await (await app.call("/api/apps/planning/projects", alice, {
      method: "POST", body: { name: "Assigned work" },
    })).json() as { id: string };
    const call = (body: unknown, ids?: string[], path = "/api/apps/planning/issues", method = "POST") =>
      app.call(path, alice, { method, body, headers: ids ? { [memberIdsHeader]: encodeMemberIds(ids) } : undefined });
    const assigned = { ...draft(project.id), assigneeId: bob.userId };
    const response = await call(assigned, [alice.userId, bob.userId]);
    assert.equal(response.status, 200);
    const issue = await response.json() as { id: string; revision: number };
    assert.equal((await call({ ...assigned, assigneeId: "other-organization-member" }, [alice.userId, bob.userId])).status, 400);
    assert.equal((await call(assigned)).status, 503);
    assert.equal((await call(draft(project.id, "Unassigned without directory"))).status, 200);
    const noDirectory = await call({ ...assigned, title: "Complete without a directory", status: "done", revision: issue.revision }, undefined, `/api/apps/planning/issues/${issue.id}`, "PUT");
    assert.equal(noDirectory.status, 200);
    const preserved = await noDirectory.json() as { revision: number; assigneeId: string; status: string };
    assert.equal(preserved.assigneeId, bob.userId);
    assert.equal(preserved.status, "done");
    issue.revision = preserved.revision;
    assert.equal((await call({ ...assigned, assigneeId: "foreign", revision: issue.revision }, undefined, `/api/apps/planning/issues/${issue.id}`, "PUT")).status, 400);
    // Bob leaves: editing other fields keeps his historical assignment, but nobody can newly assign a non-member.
    const put = (body: object, revision: number) =>
      call({ ...assigned, ...body, revision }, [alice.userId], `/api/apps/planning/issues/${issue.id}`, "PUT");
    const retitled = await put({ title: "Retitled", status: "done" }, issue.revision);
    assert.equal(retitled.status, 200);
    const kept = await retitled.json() as { assigneeId: string; revision: number };
    assert.equal(kept.assigneeId, bob.userId);
    assert.equal((await put({}, issue.revision)).status, 409);
    assert.equal((await put({ assigneeId: "carol" }, kept.revision)).status, 400);
    const reassigned = await put({ assigneeId: alice.userId }, kept.revision);
    assert.equal(reassigned.status, 200);
    const alices = await reassigned.json() as { revision: number };
    assert.equal((await put({}, alices.revision)).status, 400);
    assert.equal((await put({ assigneeId: null }, alices.revision)).status, 200);
    assert.equal((await app.call("/api/internal/publish", alice, { method: "POST", body: {} })).status, 404);
  } finally { await app.dispose(); }
});


test("the packaged demo is read-only and has no installation database", async () => {
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    assert.equal(app.hasDatabase, false);
    const health = await (await app.call("/__health")).json() as { database: string };
    assert.equal(health.database, "none");
    assert.equal((await app.call("/api/apps/planning/projects", alice, { method: "POST", body: { name: "Should not persist" } })).status, 403);
  } finally { await app.dispose(); }
});
