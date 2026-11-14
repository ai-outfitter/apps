import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { personalPortfolio, reorderPersonalPortfolio } from "../src/server/personal-portfolio";
import { readOrder, saveOrder } from "../src/server/priority-order";
import { documents, runDocument } from "../src/server/documents";
import { projects } from "../src/server/schema";

test("personal ordering is private, authorized at read/write, complete and revision checked", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    let orgs = [{ slug: "sunny", name: "Sunny" }, { slug: "keystone", name: "Keystone" }];
    const context = { db: () => db, identity: { installationId: "personal-a", userId: "a", organizationId: null, canEdit: true }, host: () => ({ call: async () => ({ viewer: { orgs } }) }) } as any;
    const input = { kind: "organizations", items: ["keystone", "sunny"], revision: 0 };
    await reorderPersonalPortfolio(context, input);
    assert.deepEqual((await personalPortfolio(context, "organizations")).items, input.items);
    const other = { ...context, identity: { ...context.identity, installationId: "personal-b", userId: "b" } };
    assert.equal((await personalPortfolio(other, "organizations")).revision, 0);
    const conflict = (e: unknown) => e instanceof Response && e.status === 409;
    await assert.rejects(reorderPersonalPortfolio(context, input), conflict);
    await assert.rejects(reorderPersonalPortfolio(context, { ...input, revision: 1, items: ["sunny"] }), conflict);
    await assert.rejects(reorderPersonalPortfolio(context, { ...input, revision: 1, items: ["sunny", "sunny"] }), conflict);
    orgs = [{ slug: "sunny", name: "Sunny" }];
    assert.deepEqual((await personalPortfolio(context, "organizations")).items, ["sunny"]);
    await assert.rejects(reorderPersonalPortfolio(context, { ...input, revision: 1 }), conflict);
    await assert.rejects(reorderPersonalPortfolio({ ...context, identity: { ...context.identity, canEdit: false } }, input), (e: unknown) => e instanceof Response && e.status === 403);
    await assert.rejects(personalPortfolio({ ...context, identity: { ...context.identity, organizationId: "shared" } }, "organizations"), (e: unknown) => e instanceof Response && e.status === 403);
    const id = "11111111-1111-4111-8111-111111111111";
    await saveOrder(db, context.identity, { kind: "projects", items: [id], revision: 0 }, [id]);
    assert.deepEqual((await readOrder(db, context.identity, "projects")).items, [id]);
    assert.deepEqual(await readOrder(db, other.identity, "projects"), { items: [], revision: 0 });
    await db.insert(projects).values({ id, installationId: "personal-a", name: "Personal project", createdBy: "a", updatedBy: "a", createdAt: 1, updatedAt: 1 });
    const index = await runDocument(documents.PortfolioProjects.document, {}, { ...context, members: () => [], host: () => { throw new Error("The index must not traverse the graph"); } });
    assert.equal(index.projects.nodes[0].rank, 0);
  } finally { client.close(); }
});

test("project portfolio traverses every authorized page with scoped identities and rejects incomplete reads", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const id = "11111111-1111-4111-8111-111111111111";
    const calls: any[] = [];
    const context = { db: () => db, identity: { installationId: "personal", userId: "a", canEdit: true }, host: () => ({ call: async (_: string, input: any) => {
      calls.push(input);
      return input.variables.cursor ? { data: { projects: [{ id, name: "Mine", state: "active", archived: false, organizationSlug: null }] } } : { data: { projects: [{ id, name: "Shared", state: "active", archived: false, organizationSlug: "sunny" }] }, next: "next" };
    } }) } as any;
    assert.deepEqual((await personalPortfolio(context, "projects")).items, [`sunny:${id}`, `personal:${id}`]);
    assert.equal(calls.length, 2);
    context.host = () => ({ call: async () => ({ data: { projects: [] }, next: "stuck" }) });
    await assert.rejects(personalPortfolio(context, "projects"), (e: unknown) => e instanceof Response && e.status === 502);
    context.host = () => ({ call: async () => { throw new Response("Access revoked", { status: 403 }); } });
    await assert.rejects(reorderPersonalPortfolio(context, { kind: "projects", items: [], revision: 0 }));
    assert.deepEqual(await readOrder(db, context.identity, "projects"), { items: [], revision: 0 });
  } finally { client.close(); }
});

test("personal Home shows the authorized portfolio in saved order and drops revoked projects", async () => {
  const { readPersonalProjects } = await import("../src/server/home-cards");
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    let rows = [{ id: first, name: "Artera-1", state: "active", archived: false, organizationSlug: "artera" }, { id: second, name: "Keystone OS", state: "active", archived: false, organizationSlug: "keystone" }];
    const context = { db: () => db, identity: { installationId: "personal", userId: "a", owner: { kind: "user", id: "a" }, canEdit: true }, host: () => ({ call: async () => ({ data: { projects: rows } }) }) } as any;
    await reorderPersonalPortfolio(context, { kind: "projects", revision: 0, items: [`keystone:${second}`, `artera:${first}`] });
    let body = await readPersonalProjects(context.db, context.host, context.identity, "large");
    let list = body.find(node => node.kind === "list")!;
    assert.equal(list.kind, "list");
    if (list.kind !== "list") throw Error("Missing list");
    assert.deepEqual(list.items.map(item => item.title), ["Keystone OS", "Artera-1"]);
    assert.deepEqual(body.at(-1), { kind: "link", label: "Open your portfolio", target: { path: "/projects" } });
    assert.equal(JSON.stringify(body).includes("No issues yet"), false);
    rows = rows.slice(0, 1);
    body = await readPersonalProjects(context.db, context.host, context.identity, "large");
    assert.equal(JSON.stringify(body).includes("Keystone OS"), false);
    context.host = () => ({ call: async () => { throw new Response("Denied", { status: 403 }); } });
    body = await readPersonalProjects(context.db, context.host, context.identity, "large");
    assert.equal(body[0].kind, "notice");
  } finally { client.close(); }
});

test("saved portfolio priorities expose a private read-only entity to sibling apps", async () => {
  const { planningEntities } = await import("../src/server/entities");
  const client = createClient({ url: ":memory:" });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const { priorityOrder } = await import("../src/server/schema");
    await db.insert(priorityOrder).values({ installationId: "mine", kind: "portfolio-organizations", items: JSON.stringify(["sunny", "keystone", "artera", "outfitter"]), revision: 3 });
    const entity = planningEntities(db).find(item => item.type === "portfolio-priority")!;
    const identity = { userId: "a", installationId: "mine", owner: { kind: "user", id: "a" }, canEdit: true } as any;
    const row = await entity.get(identity, "organizations");
    assert.equal(row.revision, 3);
    assert.deepEqual(row.attributes.items, ["sunny", "keystone", "artera", "outfitter"]);
    assert.equal(entity.create, undefined);
    assert.equal(entity.update, undefined);
    assert.deepEqual(await entity.list({ ...identity, installationId: "other" }, 0, 10), []);
    await assert.rejects(entity.get({ ...identity, installationId: "other" }, "organizations"), (error: any) => error.status === 404);
    await assert.rejects(entity.get({ ...identity, organizationId: "org", owner: { kind: "organization", id: "org" } }, "organizations"), (error: any) => error.status === 403);
  } finally { client.close(); }
});
