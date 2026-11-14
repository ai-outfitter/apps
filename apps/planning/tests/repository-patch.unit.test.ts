import assert from "node:assert/strict";
import test from "node:test";
import { planRepositoryPatch, repositoryPatch } from "../src/server/repository-patch";
const rec = (id: string, attributes: Record<string, unknown>, references: unknown[] = []) => ({ ref: { installationId: "wiki", type: "node", id }, revision: 2, title: id, attributes, references });
const graph = () => ({ wiki: { installationId: "wiki" }, types: [rec("project-type", { name: "Project" }), rec("repo-type", { name: "Repository" }), rec("source-type", { name: "source_in" })], nodes: [rec("anchor", { typeId: "project-type" }, [{ installationId: "planning", type: "project", id: "project" }]), rec("other", { typeId: "project-type" }, [{ installationId: "other-planning", type: "project", id: "project" }]), rec("repo", { typeId: "repo-type", website: "https://github.com/acme/web" })], edges: [rec("edge", { typeId: "source-type", fromId: "anchor", toId: "repo", properties: { path: "old", ref: "main" } }), rec("foreign", { typeId: "source-type", fromId: "other", toId: "repo", properties: {} })] }) as never;
test("repository patch changes only this project's edges and preserves repository path and ref", () => {
  const wanted = repositoryPatch.parse([{ url: "https://github.com/acme/web", path: "/new/", ref: "main" }, { url: "https://github.com/acme/api", path: null, ref: null }]);
  const proposals = planRepositoryPatch(graph(), "planning", "project", wanted);
  assert.equal(proposals.length, 4); assert.equal(proposals[0].operation.id, "edge"); assert.equal(proposals[0].operation.revision, 2);
  assert.deepEqual(proposals[0].operation.attributes, { archived: true });
  const links = proposals.filter(item => item.operation.operation === "create" && item.operation.type === "graph-edge");
  assert.equal(links.length, 2); assert.deepEqual((links[0].operation.attributes as Record<string, unknown>).properties, { path: "new", ref: "main" });
  assert.ok(!proposals.some(item => item.operation.id === "foreign"));
});
test("unchanged links are preserved and malformed or duplicate repository inputs are rejected", () => {
  const wanted = repositoryPatch.parse([{ url: "https://github.com/acme/web", path: "old", ref: "main" }]);
  assert.deepEqual(planRepositoryPatch(graph(), "planning", "project", wanted), []);
  assert.equal(repositoryPatch.safeParse([{ url: "https://evil.example/acme/web" }]).success, false);
  assert.equal(repositoryPatch.safeParse([{ url: "https://github.com/acme/web" }, { url: "https://github.com/ACME/web" }]).success, false);
  assert.equal(repositoryPatch.safeParse([{ url: "https://github.com/acme/web", path: "one" }, { url: "https://github.com/acme/web", path: "two" }]).success, false);
  assert.throws(() => planRepositoryPatch(graph(), "another-installation", "project", wanted));
});
