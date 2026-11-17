import assert from "node:assert/strict";
import test from "node:test";
import { reviewOwner } from "../src/server/review-owner";
import { demoGraph } from "../fixtures/graph";
import { core } from "../src/lib/graph";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
const who: AppIdentity = { owner: { kind: "organization", id: "org-a" }, organizationId: "org-a", installationId: "install-a", userId: "member", role: "member", canEdit: false };

test("host owner is known in empty and previously unbound organization graphs", () => {
  for (const graph of [{ ...demoGraph, nodes: [], edges: [] }, demoGraph]) {
    const result = reviewOwner(graph, who);
    assert.equal(result.id, "org-a");
    assert.equal(result.authority, "host-installation");
    assert.equal(result.graphNode, null);
  }
});
test("titles, foreign bindings and home settings cannot select the reviewer owner", () => {
  const graph = structuredClone(demoGraph);
  const org = graph.nodes.find(n => n.typeId === core.organization)!;
  org.title = "org-a";
  org.properties.organization_id = "org-b";
  graph.home = { organizationId: org.id };
  assert.equal(reviewOwner(graph, who).graphNode, null);
  org.properties.organization_id = "org-a";
  assert.equal(reviewOwner(graph, who).graphNode?.id, org.id);
  assert.equal(reviewOwner(graph, { ...who, owner: { kind: "organization", id: "org-b" }, organizationId: "org-b" }).graphNode, null);
  org.archived = true;
  assert.equal(reviewOwner(graph, who).graphNode, null);
});
test("duplicate graph bindings never change or obscure installation ownership", () => {
  const graph = structuredClone(demoGraph);
  const org = graph.nodes.find(n => n.typeId === core.organization)!;
  org.properties.organization_id = "org-a";
  graph.nodes.push({ ...org, id: "duplicate" });
  const result = reviewOwner(graph, who);
  assert.equal(result.id, "org-a");
  assert.equal(result.graphBinding, "ambiguous");
  assert.equal(result.graphNode, null);
});
test("personal owner is the installation account, not the actor or a graph organization", () => {
  const result = reviewOwner(demoGraph, { ...who, owner: { kind: "user", id: "personal-owner" }, organizationId: undefined, userId: "acting-agent" });
  assert.equal(result.kind, "user");
  assert.equal(result.id, "personal-owner");
  assert.equal(result.graphNode, null);
});
test("inconsistent trusted identity fails closed", () => {
  for (const identity of [ { ...who, organizationId: "foreign" }, { ...who, owner: { kind: "user" as const, id: "person" } }, { ...who, installationId: "" } ])
    assert.throws(() => reviewOwner(demoGraph, identity), (error: unknown) => error instanceof Response && error.status === 403);
});
