import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
const base = "/api/internal/entities/v1";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
// biome-ignore lint/suspicious/noExplicitAny: assert the heterogeneous API responses below.
const json = async (response: Response): Promise<any> => {
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
};
test("project entities write the actual Planning records and preserve omitted fields", async () => {
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    assert.ok((await json(await app.call(`${base}/types`, owner))).some((item: { type: string }) => item.type === "project"));
    const created = await json(await app.call(`${base}/create`, owner, { method: "POST", body: { type: "project", attributes: { name: "Artera", goals: "Build a motor" } } }));
    const issue = await json(await app.call(`${base}/create`, owner, { method: "POST", body: { type: "issue", attributes: { title: "Prototype", category: "stone", projectId: created.ref.id }, references: [created.ref] } }));
    assert.equal(issue.attributes.projectId, created.ref.id);
    const listedTypes = await json(await app.call(`${base}/types`, owner));
    assert.equal(listedTypes.find((item: { type: string }) => item.type === "project").collection, "projects");
    assert.equal(listedTypes.find((item: { type: string }) => item.type === "issue").collection, "issues");
    const scoped = await json(await app.call(`${base}/list`, owner, { method: "POST", body: { type: "issue", filter: { projectId: created.ref.id, status: "todo" }, order: { field: "position", direction: "desc" }, select: ["id", "projectId", "title"], limit: 1 } }));
    assert.equal(scoped.records[0].ref.id, issue.ref.id);
    assert.equal(scoped.records[0].references[0].id, created.ref.id);
    assert.deepEqual(scoped.pageInfo, { hasNextPage: false, endCursor: null });
    assert.equal((await app.call(`${base}/list`, owner, { method: "POST", body: { type: "issue", filter: { installationId: "other" } } })).status, 400);
    // Every advertised order is an index seek from the cursor: no scan of the table and no sort.
    const plan = async (sql: string) => (await app.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map(row => row.detail).join("; ");
    for (const [table, field] of [["planning_projects", "name"], ["planning_projects", "id"], ["planning_issues", "position"], ["planning_issues", "id"]]) {
      const after = field === "id" ? "id > 'a'" : `(${field}, id) > ('a', 'a')`;
      const order = field === "id" ? "id" : `${field}, id`;
      assert.match(await plan(`SELECT * FROM ${table} WHERE installationId = 'i' AND ${after} ORDER BY ${order} LIMIT 51`), new RegExp(`^SEARCH ${table} USING INDEX ${table}_installation_${field} \\(installationId=\\? AND .*[<>].*\\)$`));
    }
    for (const field of ["title", "createdAt", "updatedAt"])
      assert.equal((await app.call(`${base}/list`, owner, { method: "POST", body: { type: "issue", order: { field, direction: "asc" } } })).status, 400);
    const issueEdit = await json(await app.call(`${base}/update`, owner, { method: "POST", body: { type: "issue", id: issue.ref.id, revision: 1, attributes: { status: "done" }, references: [created.ref] } }));
    assert.equal(issueEdit.attributes.status, "done");
    assert.equal(issueEdit.attributes.title, "Prototype");
    const edit = { type: "project", id: created.ref.id, revision: 1, attributes: { name: "Artera motor" } };
    assert.equal((await app.call(`${base}/update`, { ...owner, role: "member" }, { method: "POST", body: edit })).status, 403);
    const saved = await json(await app.call(`${base}/update`, owner, { method: "POST", body: edit }));
    assert.equal(saved.attributes.goals, "Build a motor");
    assert.equal(saved.revision, 2);
    assert.equal((await app.call(`${base}/update`, owner, { method: "POST", body: edit })).status, 409);
    const manual = await json(await app.call('/api/apps/planning', owner));
    assert.equal(manual.projects[0].id, created.ref.id);
    assert.equal(manual.projects[0].name, "Artera motor");
  } finally { await app.dispose(); }
});
