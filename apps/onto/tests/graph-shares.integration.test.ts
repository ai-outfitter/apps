import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { print } from "graphql";
import { documents } from "../src/server/documents";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "artera", role: "owner" };
const member = { ...owner, userId: "member", role: "member" };
const path = "/api/internal/actions/v1/call";
// biome-ignore lint/suspicious/noExplicitAny: test JSON
type Json = any;
type Who = typeof owner;

test("a share shows another organization a KnowledgeGraph from its roots, minus hidden nodes, over current records", async (t) => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"));
  t.after(() => app.dispose());
  assert.equal((await app.call("/api/internal/app-initialize", owner, { method: "POST", body: {} })).status, 200);
  const action = async (who: Who, name: string, input: object) => {
    const response = await app.call(path, who, { method: "POST", body: { action: name, input } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Json>;
  };
  const run = (name: keyof typeof documents, variables: object, who: Who = owner) => {
    const document = documents[name].document as unknown;
    const query = typeof document === "string" ? document : print(document as Parameters<typeof print>[0]);
    return action(who, name.startsWith("Mutate") ? "graph.mutate" : "graph.graphql", { query, operationName: name, variables });
  };
  const { types } = await action(owner, "graph.read", {});
  const type = (name: string) => types.find((row: Json) => row.name === name)?.id as string;
  const node = (ref: string, typeName: string, title: string, slug: string) => ({ operation: "create", ref, type: "graph-node", attributes: { typeId: type(typeName), title, slug } });
  const edge = (ref: string, typeName: string, fromId: string, toId: string) => ({ operation: "create", ref, type: "graph-edge", attributes: { typeId: type(typeName), fromId, toId } });
  // Artera's graph: the sensor Sunny repackages, its firmware, an internal project Artera keeps to itself, and an unrelated product.
  await action(owner, "graph.apply", { requestKey: "share-fixture", operations: [
    node("$artera", "Organization", "Artera", "artera"),
    node("$sunny", "Organization", "Sunny", "sunny"),
    node("$sensor", "Product", "SNSP-1", "snsp-1"),
    node("$firmware", "Project", "SNSP-1 firmware", "snsp-1-firmware"),
    node("$costing", "Project", "SNSP-1 costing", "snsp-1-costing"),
    node("$secret", "Product", "Artera-2", "artera-2"),
    edge("$e1", "produces", "$firmware", "$sensor"),
    edge("$e2", "produces", "$costing", "$sensor"),
    edge("$e3", "developed_by", "$sensor", "$artera"),
    edge("$e4", "developed_by", "$secret", "$artera"),
    { operation: "create", ref: "$lens", type: "graph-node", attributes: { typeId: core.knowledgeGraph, title: "Supply", slug: "supply",
      body: JSON.stringify({ name: "Supply", purpose: "What a customer sees of a product", rootTypes: ["Product"],
        selection: { relationships: [{ type: "produces", direction: "incoming" }, "developed_by"], maxDepth: 2, maxNodes: 50 } }) } },
  ] });

  const share = { title: "Sunny supply", organization: "Organization:sunny", graph: "KnowledgeGraph:supply", roots: { "Product:snsp-1": true }, hidden: { "Project:snsp-1-costing": true } };
  const created = await run("MutateShare", { input: { slug: "sunny", expectedRevision: 0, patch: share } });
  assert.equal(created.errors, undefined, JSON.stringify(created.errors));
  const first = created.data.mutateShare;
  assert.equal(first.revision, 1);
  assert.deepEqual(first.view.nodes.map((n: Json) => n.address).sort(), ["Organization:artera", "Product:snsp-1", "Project:snsp-1-firmware"]);
  assert.deepEqual(first.view.edges.map((e: Json) => e.address).sort(), [
    "developed_by(Product:snsp-1 → Organization:artera)", "produces(Project:snsp-1-firmware → Product:snsp-1)",
  ]);
  assert.ok(!JSON.stringify(first).includes("artera-2"), "the KnowledgeGraph's direction and depth keep other products out");

  // Reads walk current records: a new firmware project shows up without changing the share.
  await action(owner, "graph.apply", { requestKey: "share-later", operations: [
    { operation: "create", ref: "$app", type: "graph-node", attributes: { typeId: type("Project"), title: "SNSP-1 app", slug: "snsp-1-app" } },
    { operation: "create", ref: "$e5", type: "graph-edge", attributes: { typeId: type("produces"), fromId: "$app", toId: (await action(owner, "graph.read", {})).nodes.find((n: Json) => n.slug === "snsp-1").id } },
  ] });
  const preview = await run("Share", { slug: "sunny" }, member);
  assert.equal(preview.errors, undefined, JSON.stringify(preview.errors));
  assert.ok(preview.data.share.view.nodes.some((n: Json) => n.address === "Project:snsp-1-app"), "any member can preview what Sunny reads");

  const listed = await run("Shares", {}, member);
  assert.deepEqual(listed.data.shares.map((s: Json) => [s.slug, s.organization, s.graph]), [["sunny", "Organization:sunny", "KnowledgeGraph:supply"]]);

  // Only editors share, at the revision they read, with real nodes, never hiding a root.
  const byMember = await app.call(path, member, { method: "POST", body: { action: "graph.mutate", input: { query: documents.MutateShare.document, operationName: "MutateShare",
    variables: { input: { slug: "sunny", expectedRevision: 1, patch: { hidden: { "Project:snsp-1-app": true } } } } } } });
  assert.equal(byMember.status, 403);
  assert.match(JSON.stringify((await run("MutateShare", { input: { slug: "sunny", expectedRevision: 0, patch: {} } })).errors), /revision 1/);
  assert.match(JSON.stringify((await run("MutateShare", { input: { slug: "sunny", expectedRevision: 1, patch: { organization: "Product:snsp-1" } } })).errors), /not an Organization/);
  assert.match(JSON.stringify((await run("MutateShare", { input: { slug: "sunny", expectedRevision: 1, patch: { hidden: { "Product:snsp-1": true } } } })).errors), /root cannot be hidden/);

  const stopped = await run("MutateShare", { input: { slug: "sunny", expectedRevision: 1, patch: {}, archived: true } });
  assert.equal(stopped.errors, undefined, JSON.stringify(stopped.errors));
  assert.equal(stopped.data.mutateShare.archived, true);
  assert.equal(stopped.data.mutateShare.view, null, "an archived share shows nothing");
});
