import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "./fixtures/initialized-worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { core } from "../src/lib/graph";
import { create } from "./fixtures/relators";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const id = (n: number) => `7d0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const partOf = "71000000-0000-4000-8000-000000000032";
const evidence = [{ provider: "web", recordId: "synthetic", quote: "Synthetic test research" }];
async function json(r: Response): Promise<any> { assert.equal(r.status, 200, await r.clone().text()); return r.json(); }
async function fixture(identity = owner) {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "root-test");
  const action = (action: string, input: object, who = identity) => app.call("/api/internal/actions/v1/call", who, { method: "POST", body: { action, input } });
  const apply = async (operations: object[]) => json(await action("graph.apply", { requestKey: crypto.randomUUID(), operations }));
  const root = () => apply([create("$root", "graph-node", { id: id(1), typeId: core.organization, title: "Owner", slug: "owner", properties: { organization_id: "org" } })]);
  const stage = async (anchors?: string[], linked = false) => {
    const { batch } = await json(await action("batch.open", { title: "Research", ...(anchors === undefined ? {} : { anchors }) }));
    await json(await action("batch.add", { batchId: batch.id, proposals: [
      { operation: create("$doc", "graph-node", { id: id(2), typeId: core.document, title: "Research", slug: "research" }), evidence },
      ...(linked ? [{ operation: create("$link", "graph-edge", { id: id(3), typeId: partOf, fromId: "$doc", toId: "Organization:owner" }), evidence }] : []),
    ] }));
    return batch;
  };
  const validate = async (batch: any) => (await json(await app.call(`/api/apps/onto/batches/get?id=${batch.id}`, identity))).validation;
  return { app, action, apply, root, stage, validate };
}
test("missing roots permit staging but not submission; explicit editor bootstrap unlocks connected batches", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  const guide = await json(await f.action("graph.graphql", { query: "{ ontology { root staging } }" }));
  assert.equal(guide.data.ontology.root, null);
  assert.match(guide.data.ontology.staging, /EnsureOwnerRoot/);
  assert.doesNotMatch(guide.data.ontology.staging, /new nodes need no connection/);
  const batch = await f.stage([], true);
  assert.equal((await f.action("batch.submit", { batchId: batch.id })).status, 409);
  await f.root();
  assert.equal((await f.validate(batch)).valid, true);
  await json(await f.action("batch.submit", { batchId: batch.id }));
  await json(await f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId: batch.id, verdict: "approve" } }));
});
test("empty anchors default to root and cannot disable connectivity through configure", async t => {
  const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
  const batch = await f.stage([]);
  assert.deepEqual(batch.anchors, [id(1)]);
  assert.equal((await f.validate(batch)).valid, false);
  const configured = await json(await f.action("graph.mutate", { query: "mutation($input: ConfigureBatchInput!) { configureBatch(input: $input) { id } }", variables: { input: { batchId: batch.id, anchors: [] } } }));
  assert.equal(configured.errors, undefined, JSON.stringify(configured));
  assert.deepEqual((await json(await f.action("batch.get", { batchId: batch.id }))).batch.anchors, [id(1)]);
});
test("legacy null anchors and disconnected explicit anchors cannot bypass the root", async t => {
  const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
  await f.apply([create("$other", "graph-node", { id: id(4), typeId: core.organization, title: "Other", slug: "other" })]);
  const batch = await f.stage(["Organization:other"]);
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: create("$other-link", "graph-edge", { id: id(5), typeId: partOf, fromId: "$doc", toId: "Organization:other" }), evidence }] }));
  assert.equal((await f.validate(batch)).valid, false);
  assert.deepEqual((await json(await f.action("batch.get", { batchId: batch.id }))).batch.anchors, [id(4)]);
  await f.app.database.prepare("UPDATE graph_batches SET anchors=NULL WHERE id=?").bind(batch.id).run();
  assert.equal((await f.validate(batch)).valid, false);
  // A historical submitted batch must also be checked at the final member commit.
  await f.app.database.prepare("UPDATE graph_batches SET state='awaiting_review' WHERE id=?").bind(batch.id).run();
  await f.app.database.prepare("UPDATE graph_batch_operations SET state='awaiting_review' WHERE batchId=?").bind(batch.id).run();
  assert.equal((await f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId: batch.id, verdict: "approve" } })).status, 409);
});
test("duplicate roots block validation and root removal after submit blocks approval", async t => {
  const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
  const batch = await f.stage(undefined, true);
  await f.apply([create("$duplicate", "graph-node", { id: id(4), typeId: core.organization, title: "Duplicate", properties: { organization_id: "org" } })]);
  assert.match((await f.validate(batch)).error, /ambiguous/);
  await f.apply([{ operation: "update", ref: "$duplicate", type: "graph-node", id: id(4), revision: 1, attributes: { archived: true } }]);
  await json(await f.action("batch.submit", { batchId: batch.id }));
  await f.apply([{ operation: "update", ref: "$root", type: "graph-node", id: id(1), revision: 1, attributes: { archived: true } }]);
  assert.equal((await f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId: batch.id, verdict: "approve" } })).status, 409);
});
test("a batch cannot archive its own root as part of an otherwise connected proposal", async t => {
  const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
  const batch = await f.stage(undefined, true);
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: { operation: "update", ref: "$archive", type: "graph-node", id: id(1), revision: 1, attributes: { archived: true } }, evidence }] }));
  assert.equal((await f.validate(batch)).valid, false);
});
test("personal bootstrap uses the owner's account link and empty anchors retain that root", async t => {
  const me = { userId: "actor", organizationId: "", role: "owner", owner: { kind: "user", id: "personal-owner" } };
  const f = await fixture(me); t.after(() => f.app.dispose());
  const batch = await f.stage([]);
  assert.match((await f.validate(batch)).error, /root/);
  await f.apply([create("$me", "graph-node", { id: id(1), typeId: core.person, title: "Me", slug: "me" })]);
  await json(await f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } }));
  const opened = await json(await f.action("batch.open", { title: "Personal", anchors: [] }));
  assert.deepEqual(opened.batch.anchors, [id(1)]);
  assert.equal((await f.validate(batch)).valid, false); // Root exists, but the document remains disconnected.
});
test("confidence and first-run policies cannot commit disconnected nodes with empty anchors", async t => {
  for (const policy of [{ kind: "confidence", threshold: 0.95, version: "test" }, { kind: "first-run", version: "test" }]) {
    const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
    const actor = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
    const { batch } = await json(await f.action("batch.open", { title: "Discovery", anchors: [], policy, source: { kind: "discovery-run", ref: "test" } }, actor));
    await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: create("$doc", "graph-node", { id: id(2), typeId: core.document, title: "Disconnected" }), evidence, confidence: 0.99 }] }, actor));
    const submitted = await json(await f.action("batch.submit", { batchId: batch.id }, actor));
    assert.equal(submitted.counts.committed ?? 0, 0);
    assert.equal(submitted.counts.awaiting_review, 1);
    assert.equal((await f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId: batch.id, verdict: "approve" } })).status, 409);
  }
});
test("foreign organization bindings never bootstrap this installation", async t => {
  const f = await fixture(); t.after(() => f.app.dispose());
  await f.apply([create("$foreign", "graph-node", { id: id(1), typeId: core.organization, title: "Owner", slug: "owner", properties: { organization_id: "other-tenant" } })]);
  const batch = await f.stage([], true);
  assert.match((await f.validate(batch)).error, /root.*absent/);
});
test("personal ambiguous identity stays blocked until the editor repairs the account link", async t => {
  const me = { userId: "actor", organizationId: "", role: "owner", owner: { kind: "user", id: "personal-owner" } };
  const f = await fixture(me); t.after(() => f.app.dispose());
  await f.apply([
    create("$me", "graph-node", { id: id(1), typeId: core.person, title: "Me", slug: "me" }),
    create("$other", "graph-node", { id: id(4), typeId: core.person, title: "Other", slug: "other" }),
  ]);
  await json(await f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } }));
  const account = await f.app.database.prepare("SELECT id FROM graph_nodes WHERE externalKey=?").bind("ai-outfitter.com/users:personal-owner").first<{ id: string }>();
  assert.ok(account);
  await f.apply([create("$duplicate", "graph-edge", { id: id(5), typeId: "71000000-0000-4000-8000-000000000122", fromId: account.id, toId: id(4) })]);
  const batch = await f.stage([]);
  assert.match((await f.validate(batch)).error, /ambiguous/);
  // The existing editor identity API reconciles conflicting account links.
  await json(await f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } }));
  assert.deepEqual((await json(await f.action("batch.open", { title: "Repaired", anchors: [] }))).batch.anchors, [id(1)]);
});
test("root binding and saved-anchor races invalidate the final commit snapshot", async t => {
  for (const change of ["root", "anchors"]) {
    const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
    const batch = await f.stage(undefined, true);
    await json(await f.action("batch.submit", { batchId: batch.id }));
    const client = f.app.database, original = client.batch.bind(client);
    let injected = false;
    const proxy = new Proxy(client, { get(target, key) {
      if (key === "batch") return async (statements: any[]) => {
        if (!injected) {
          injected = true;
          if (change === "root") await client.prepare("UPDATE graph_nodes SET properties=json_set(properties,'$.organization_id','foreign'),revision=revision+1 WHERE id=?").bind(id(1)).run();
          else await client.prepare("UPDATE graph_batches SET anchors=NULL WHERE id=?").bind(batch.id).run();
        }
        return original(statements);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const { drizzle } = await import("drizzle-orm/d1");
    const { reviewBatch } = await import("../src/server/graph-batches");
    const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
    await assert.rejects(reviewBatch(drizzle(proxy), who, { kind: "member", id: "owner" }, { kind: "member", id: "owner" }, { batchId: batch.id, verdict: "approve" }), (e: unknown) => e instanceof Response && e.status === 409);
    assert.equal(injected, true);
    assert.equal(await client.prepare("SELECT id FROM graph_nodes WHERE id=?").bind(id(2)).first(), null);
    assert.equal((await client.prepare("SELECT commits FROM graph_batches WHERE id=?").bind(batch.id).first())?.commits, 0);
  }
});
test("partial member and policy decisions cannot detach earlier creates from the same batch", async t => {
  for (const automated of [false, true]) {
    const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
    await f.apply([
      create("$dossier", "graph-node", { id: id(4), typeId: core.document, title: "Dossier", slug: "dossier" }),
      create("$original", "graph-edge", { id: id(5), typeId: partOf, fromId: "$dossier", toId: "Organization:owner" }),
    ]);
    const actor = automated ? { ...owner, actor: { kind: "app" as const, id: "forerunner" } } : owner;
    const { batch } = await json(await f.action("batch.open", { title: "Replace context", ...(automated ? { policy: { kind: "confidence", threshold: 0.95, version: "test" } } : {}) }, actor));
    await json(await f.action("batch.add", { batchId: batch.id, proposals: [
      { operation: create("$doc", "graph-node", { id: id(2), typeId: core.document, title: "Research" }), confidence: 0.99, evidence },
      { operation: create("$child", "graph-edge", { id: id(3), typeId: partOf, fromId: "$doc", toId: "Document:dossier" }), confidence: 0.99, evidence },
      { operation: { operation: "update", ref: "$archive", type: "graph-edge", id: id(5), revision: 1, attributes: { archived: true } }, confidence: 0.1, evidence },
      { operation: create("$replacement", "graph-edge", { id: id(6), typeId: "documents", fromId: "Document:dossier", toId: "Organization:owner" }), confidence: 0.1, evidence },
    ] }, actor));
    await json(await f.action("batch.submit", { batchId: batch.id }, actor));
    const decide = (refs: string[]) => f.app.call("/api/apps/onto/batches/review", owner, { method: "POST", body: { batchId: batch.id, verdict: "approve", refs } });
    if (!automated) await json(await decide(["$doc", "$child"]));
    assert.equal((await json(await f.action("batch.get", { batchId: batch.id }))).counts.committed, 2);
    assert.equal((await decide(["$archive"])).status, 409);
    assert.equal((await f.app.database.prepare("SELECT archived FROM graph_edges WHERE id=?").bind(id(5)).first())?.archived, 0);
    assert.equal((await json(await decide(["$archive", "$replacement"]))).batch.state, "committed");
  }
});
test("a real identity unlink during approval invalidates the personal-root snapshot", async t => {
  const me = { userId: "actor", organizationId: "", role: "owner", owner: { kind: "user" as const, id: "personal-owner" } };
  const f = await fixture(me); t.after(() => f.app.dispose());
  await f.apply([create("$me", "graph-node", { id: id(1), typeId: core.person, title: "Me", slug: "me" })]);
  await json(await f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } }));
  const batch = await f.stage([]);
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [{ operation: create("$context", "graph-edge", { id: id(3), typeId: partOf, fromId: "$doc", toId: "Person:me" }), evidence }] }));
  await json(await f.action("batch.submit", { batchId: batch.id }));
  const { drizzle } = await import("drizzle-orm/d1");
  const { unlinkIdentity } = await import("../src/server/identity");
  const { reviewBatch } = await import("../src/server/graph-batches");
  const client = f.app.database, original = client.batch.bind(client);
  const who = { ...me, installationId: f.app.installationId, canEdit: true };
  let injected = false;
  const proxy = new Proxy(client, { get(target, key) {
    if (key === "batch") return async (statements: any[]) => {
      if (!injected) { injected = true; await unlinkIdentity(drizzle(client), who, id(1)); }
      return original(statements);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(reviewBatch(drizzle(proxy), who, { kind: "member", id: "actor" }, { kind: "member", id: "actor" }, { batchId: batch.id, verdict: "approve" }), (e: unknown) => e instanceof Response && e.status === 409);
  assert.equal(injected, true);
  assert.equal(await client.prepare("SELECT id FROM graph_nodes WHERE id=?").bind(id(2)).first(), null);
});
test("explicit identity relinking restores an archived account without duplicate account links", async t => {
  const me = { userId: "actor", organizationId: "", role: "owner", owner: { kind: "user", id: "personal-owner" } };
  const f = await fixture(me); t.after(() => f.app.dispose());
  await f.apply([create("$me", "graph-node", { id: id(1), typeId: core.person, title: "Me", slug: "me" })]);
  const link = () => f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } });
  await json(await link());
  const account = await f.app.database.prepare("SELECT id,revision FROM graph_nodes WHERE externalKey=?").bind("ai-outfitter.com/users:personal-owner").first<{ id: string; revision: number }>();
  assert.ok(account);
  // Public graph validation forbids archiving an endpoint of an active edge.
  await json(await f.app.call("/api/internal/identity/v1/unlink", me, { method: "POST", body: { holderId: id(1) } }));
  await f.apply([{ operation: "update", ref: "$archive", type: "graph-node", id: account.id, revision: account.revision, attributes: { archived: true } }]);
  await json(await link()); await json(await link());
  assert.deepEqual((await json(await f.action("batch.open", { title: "Restored", anchors: [] }))).batch.anchors, [id(1)]);
  assert.equal((await f.app.database.prepare("SELECT count(*) AS n FROM graph_edges WHERE fromId=? AND archived=0").bind(account.id).first())?.n, 1);
  assert.equal((await f.app.database.prepare("SELECT revision FROM graph_nodes WHERE id=?").bind(account.id).first())?.revision, account.revision + 2);
});
test("a concurrent approval cannot hide new connectivity obligations behind a fresh graph snapshot", async t => {
  const f = await fixture(); t.after(() => f.app.dispose()); await f.root();
  await f.apply([
    create("$dossier", "graph-node", { id: id(4), typeId: core.document, title: "Dossier", slug: "dossier" }),
    create("$original", "graph-edge", { id: id(5), typeId: partOf, fromId: "$dossier", toId: "Organization:owner" }),
  ]);
  const { batch } = await json(await f.action("batch.open", { title: "Concurrent replacement" }));
  await json(await f.action("batch.add", { batchId: batch.id, proposals: [
    { operation: create("$doc", "graph-node", { id: id(2), typeId: core.document, title: "Research" }), evidence },
    { operation: create("$child", "graph-edge", { id: id(3), typeId: partOf, fromId: "$doc", toId: "Document:dossier" }), evidence },
    { operation: { operation: "update", ref: "$archive", type: "graph-edge", id: id(5), revision: 1, attributes: { archived: true } }, evidence },
    { operation: create("$replacement", "graph-edge", { id: id(6), typeId: "documents", fromId: "Document:dossier", toId: "Organization:owner" }), evidence },
  ] }));
  await json(await f.action("batch.submit", { batchId: batch.id }));
  const { drizzle } = await import("drizzle-orm/d1");
  const { reviewBatch } = await import("../src/server/graph-batches");
  const client = f.app.database;
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  const actor = { kind: "member" as const, id: "owner" };
  let interleaved: Promise<unknown> | undefined;
  // B has read its batch and operations before its first graph-table read. A's
  // approval then completes before EVERY graph read, so B sees a fresh graph.
  const wrap = (statement: any, graphRead: boolean): any => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), graphRead);
    if (graphRead && (key === "raw" || key === "all")) return async (...args: unknown[]) => {
      interleaved ??= reviewBatch(drizzle(client), who, actor, actor, { batchId: batch.id, verdict: "approve", refs: ["$doc", "$child"] });
      await interleaved;
      return target[key](...args);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const proxy = new Proxy(client, { get(target, key) {
    if (key === "prepare") return (query: string) => wrap(target.prepare(query), /from "graph_(types|nodes|edges)"/.test(query));
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(reviewBatch(drizzle(proxy), who, actor, actor, { batchId: batch.id, verdict: "approve", refs: ["$archive"] }), (e: unknown) => e instanceof Response && e.status === 409);
  assert.ok(interleaved);
  assert.equal((await json(await f.action("batch.get", { batchId: batch.id }))).counts.committed, 2);
  assert.equal((await client.prepare("SELECT archived FROM graph_edges WHERE id=?").bind(id(5)).first())?.archived, 0);
});
test("relink repairs a historical archived-account row with its retained active edge", async t => {
  const me = { userId: "actor", organizationId: "", role: "owner", owner: { kind: "user", id: "personal-owner" } };
  const f = await fixture(me); t.after(() => f.app.dispose());
  await f.apply([create("$me", "graph-node", { id: id(1), typeId: core.person, title: "Me", slug: "me" })]);
  const link = () => f.app.call("/api/internal/identity/v1/link", me, { method: "POST", body: { holderId: id(1), principalId: "personal-owner", kind: "human" } });
  await json(await link());
  const account = await f.app.database.prepare("SELECT id FROM graph_nodes WHERE externalKey=?").bind("ai-outfitter.com/users:personal-owner").first<{ id: string }>();
  assert.ok(account);
  // Deliberately model legacy inconsistent storage, not a permitted graph.apply:
  // current ontology validation correctly rejects archiving an active endpoint.
  await f.app.database.prepare("UPDATE graph_nodes SET archived=1,revision=revision+1 WHERE id=?").bind(account.id).run();
  await json(await link()); await json(await link());
  assert.equal((await f.app.database.prepare("SELECT count(*) AS n FROM graph_edges WHERE fromId=? AND archived=0").bind(account.id).first())?.n, 1);
  assert.deepEqual((await json(await f.action("batch.open", { title: "Repaired legacy identity", anchors: [] }))).batch.anchors, [id(1)]);
});
