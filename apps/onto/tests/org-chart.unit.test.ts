import assert from "node:assert/strict";
import test from "node:test";
import { organizationChart } from "../src/lib/org-chart";
import { layoutKnowledgeGraph } from "@ai-outfitter/ui/knowledge-graph/layout";
import { chartFixture, chartId } from "./fixtures/org-chart";

test("org chart separates board membership from executive scope and nests recorded direct reports", async () => {
  const { graph, organization, board } = chartFixture();
  const view = organizationChart(graph, organization);
  assert.equal(view.positions.length, 3);
  assert.equal(view.reportingLines, 1);
  assert.ok(view.chart.edges.some(edge => edge.fromId === board.id && edge.toId === chartId(2)));
  assert.ok(view.chart.edges.some(edge => edge.fromId === chartId(3) && edge.toId === chartId(4) && edge.typeId === "chart-report"));
  assert.match(view.chart.nodes.find(node => node.id === chartId(3))!.title, /Chief Executive Officer.*Executive lead/);
  assert.equal(organizationChart(graph, board).root.id, organization.id);
  const layout = await layoutKnowledgeGraph(view.chart, view.chart, { direction: "DOWN" });
  const parent = layout.layout.children!.find(node => node.id === chartId(3))!;
  const child = layout.layout.children!.find(node => node.id === chartId(4))!;
  assert.ok(child.y! > parent.y!);
});
test("archived, unrelated assignments and ambiguous holder reporting never create invented reporting lines", () => {
  const { graph, organization, edge } = chartFixture();
  graph.edges.find(edge => edge.id === chartId(150))!.archived = true;
  graph.nodes.push({ ...organization, id: chartId(30), title: "Other organization" },
    { ...graph.nodes.find(node => node.id === chartId(4))!, id: chartId(31), title: "Other organization assignment" });
  graph.edges.push(edge(170,"scoped_to",chartId(31),chartId(30)),edge(171,"assigns_role",chartId(31),chartId(10)),edge(172,"assigned_to",chartId(31),chartId(7)));
  const view = organizationChart(graph, organization);
  assert.equal(view.reportingLines, 0);
  assert.equal(view.positions.length, 3);
  assert.ok(!view.chart.nodes.some(node => node.id === chartId(31)));
  const proposed = edge(161,"reports_to",chartId(4),chartId(3));
  proposed.properties = { status: "proposed" };
  graph.edges.push(proposed);
  assert.ok(organizationChart(graph, organization).chart.edges.some(edge => edge.typeId === "chart-proposed-report"));
  graph.edges.push(edge(160,"reports_to",chartId(3),chartId(3)));
  assert.equal(organizationChart(graph, organization).unresolvedReports, 1);
  graph.nodes.find(node => node.id === chartId(4))!.archived = true;
  assert.equal(organizationChart(graph, organization).positions.length, 2);
});
