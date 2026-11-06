import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { appWorker, type Member } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";

const path = "/api/apps/software-foundry/projects";
const artifact = appArtifact(new URL("..", import.meta.url), "operational");
const project = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  repositories: z.array(z.string()),
  milestones: z.array(z.string()),
  revision: z.number(),
  // Epoch milliseconds, as GET serves it; POST runs the CreateProject document and answers the same shape.
  updatedAt: z.number().int().positive(),
});
const listing = z.object({ projects: z.array(project), canEdit: z.boolean() });

test("Software Foundry projects group repositories, rank milestones by title and enforce editor roles and revisions", async () => {
  const app = await appWorker("software-foundry", artifact);
  try {
    const owner: Member = { userId: "owner", organizationId: "alpha", role: "owner" };
    const admin: Member = { userId: "admin", organizationId: "alpha", role: "member,admin" };
    const viewer: Member = { userId: "viewer", organizationId: "alpha", role: "member" };
    const call = (
      route: string,
      caller: Member | undefined,
      init?: { method?: string; body?: unknown },
    ) => app.call(route, caller, init);
    const status = async (...args: Parameters<typeof call>) => (await call(...args)).status;
    const json = async <T>(schema: z.ZodType<T>, ...args: Parameters<typeof call>) => {
      const response = await call(...args);
      assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      return schema.parse(await response.json());
    };
    const list = (caller: Member) => json(listing, path, caller);

    // The platform forwards identity; without it the app answers nothing.
    assert.equal(await status(path, undefined), 401);
    assert.deepEqual(await list(owner), { projects: [], canEdit: true });
    assert.equal((await list(viewer)).canEdit, false);
    assert.equal(
      await status(path, viewer, { method: "POST", body: { name: "web", repositories: [] } }),
      403,
    );
    for (const invalid of [
      { name: "", repositories: [] },
      { name: "web", repositories: ["not a repository"] },
      { name: "web", repositories: [], extra: true },
    ])
      assert.equal(await status(path, owner, { method: "POST", body: invalid }), 400);

    // Names are upper case and unique; repositories lower case, once each.
    const outfitter = await json(project, path, owner, {
      method: "POST",
      body: { name: "outfitter  app", repositories: ["Alpha/Web", "alpha/api", "alpha/web"] },
    });
    assert.equal(outfitter.name, "OUTFITTER APP");
    assert.deepEqual(outfitter.repositories, ["alpha/web", "alpha/api"]);
    assert.equal(outfitter.position, 0);
    const docs = await json(project, path, admin, {
      method: "POST",
      body: { name: "docs", repositories: ["alpha/web"] },
    });
    assert.equal(docs.position, 1);
    assert.equal(
      await status(path, owner, { method: "POST", body: { name: "Docs", repositories: [] } }),
      409,
    );
    // Audit fields are stored but never exposed.
    const audit = await app.database
      .prepare("SELECT createdBy FROM foundry_projects WHERE id = ?")
      .bind(docs.id)
      .first<{ createdBy: string }>();
    assert.equal(audit?.createdBy, "admin");
    assert.ok(!JSON.stringify(await list(viewer)).includes("createdBy"));

    // Rank milestones by title; a title is ranked once.
    const item = `${path}/${outfitter.id}`;
    assert.equal(
      await status(item, owner, {
        method: "PUT",
        body: { milestones: ["Launch", "launch "], revision: outfitter.revision },
      }),
      400,
    );
    assert.equal(
      await status(item, viewer, { method: "PUT", body: { milestones: [], revision: 1 } }),
      403,
    );
    const ranked = await json(project, item, owner, {
      method: "PUT",
      body: { milestones: ["Design  Tokens", "Launch"], revision: outfitter.revision },
    });
    assert.deepEqual(ranked.milestones, ["design tokens", "launch"]);
    assert.equal(ranked.revision, outfitter.revision + 1);
    // A stale revision is refused rather than overwriting the newer ranking.
    assert.equal(
      await status(item, owner, {
        method: "PUT",
        body: { name: "stale", revision: outfitter.revision },
      }),
      409,
    );
    // Changing repositories keeps the ranking; titles are not tied to one.
    const narrowed = await json(project, item, owner, {
      method: "PUT",
      body: { repositories: ["alpha/web"], revision: ranked.revision },
    });
    assert.deepEqual(narrowed.milestones, ["design tokens", "launch"]);

    // Priority order lists every project exactly once.
    const order = `${path}/order`;
    assert.equal(await status(order, owner, { method: "PUT", body: { ids: [docs.id] } }), 409);
    const ordered = await json(z.object({ projects: z.array(project) }), order, owner, {
      method: "PUT",
      body: { ids: [docs.id, outfitter.id] },
    });
    assert.deepEqual(
      ordered.projects.map(({ name, position }) => [name, position]),
      [
        ["DOCS", 0],
        ["OUTFITTER APP", 1],
      ],
    );

    // Deleting needs the current revision and closes the priority gap, so a
    // new project sorts last.
    const docsItem = `${path}/${docs.id}`;
    assert.equal(
      await status(docsItem, owner, { method: "DELETE", body: { revision: docs.revision + 5 } }),
      409,
    );
    assert.equal(
      await status(`${path}/not-a-uuid`, owner, { method: "DELETE", body: { revision: 1 } }),
      404,
    );
    assert.equal(
      await status(docsItem, owner, { method: "DELETE", body: { revision: docs.revision } }),
      200,
    );
    await json(project, path, owner, { method: "POST", body: { name: "site", repositories: [] } });
    assert.deepEqual(
      (await list(viewer)).projects.map(({ name, position }) => [name, position]),
      [
        ["OUTFITTER APP", 0],
        ["SITE", 1],
      ],
    );
  } finally {
    await app.dispose();
  }
});
