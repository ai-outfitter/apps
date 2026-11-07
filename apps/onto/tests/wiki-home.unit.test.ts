import assert from "node:assert/strict";
import test from "node:test";
import { core, type GraphNode } from "../src/lib/graph";
import { wikiHome } from "../src/server/wiki-home";
import { demoGraph } from "../fixtures/graph";
const who = { organizationId: "our-org", installationId: "our-wiki" };
function fixture() {
  const graph = structuredClone(demoGraph);
  const org = graph.nodes.find(node => node.id === "73000000-0000-4000-8000-000000000001")!;
  org.properties.organization_id = who.organizationId;
  return { graph, org };
}
test("Wiki home selects the bound organization, never a similarly named record or another tenant", () => {
  const { graph, org } = fixture();
  assert.equal(wikiHome(graph, who).organizationId, org.id);
  assert.deepEqual(wikiHome(graph, { ...who, organizationId: "different" }), {});
  assert.deepEqual(wikiHome(graph, { installationId: who.installationId }), {});
  graph.nodes.push({ ...org, id: "duplicate", slug: "duplicate" });
  assert.deepEqual(wikiHome(graph, who), {});
});
test("an existing Governance selection is checked against the current Wiki", () => {
  const { graph, org } = fixture();
  graph.types.push({ ...graph.types[0], id: "settings-type", name: "GovernanceHomeSettings", category: "node" });
  const other = graph.nodes.find(node => node.typeId === core.organization && node.id !== org.id)!;
  const settings = { ...org, id: "settings", typeId: "settings-type", body: JSON.stringify({ schema_version: 1, organization_root: { installationId: who.installationId, type: "graph-node", id: other.id } }) };
  graph.nodes.push(settings);
  assert.equal(wikiHome(graph, who).organizationId, other.id);
  settings.body = settings.body.replace(who.installationId, "another-wiki");
  assert.equal(wikiHome(graph, who).organizationId, org.id);
});
test("only one adopted charter for the selected organization becomes its charter link", () => {
  const { graph, org } = fixture();
  graph.types.push({ ...graph.types[0], id: "charter-type", name: "BoardCharter", category: "node" });
  const charter: GraphNode = { ...org, id: "charter", typeId: "charter-type", body: JSON.stringify({ organization_id: org.id, status: "draft" }) };
  graph.nodes.push(charter);
  assert.equal(wikiHome(graph, who).charterId, undefined);
  charter.body = charter.body.replace('"draft"', '"adopted"');
  assert.equal(wikiHome(graph, who).charterId, charter.id);
  graph.nodes.push({ ...charter, id: "second-charter" });
  assert.equal(wikiHome(graph, who).charterId, undefined);
});
