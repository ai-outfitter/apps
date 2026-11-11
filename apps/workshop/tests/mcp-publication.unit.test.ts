import assert from "node:assert/strict";
import test from "node:test";
import rows from "../graph/documents.json" with { type: "json" };

// Workshop chooses what agents see over MCP (publishDocuments). The batch writes and the
// collection reads are published; the single-action documents stay for Workshop's pages.
test("Workshop publishes its batch writes and collection reads to MCP", () => {
  const published = rows.filter(row => !row.hidden).map(row => row.name).sort();
  assert.deepEqual(published, ["AssemblyChanges", "ConceptChanges", "ProductRevisionChanges", "ProjectChanges", "UnitChanges", "WorkshopProjectHandoff", "WorkshopProjects", "WorkshopUnits"]);
  for (const row of rows.filter(row => !row.hidden)) assert.ok((row as { mcp?: { description: string } }).mcp?.description, `${row.name} needs an MCP description`);
  const collections = rows.filter(row => (row as { federation?: unknown }).federation).map(row => row.name).sort();
  assert.deepEqual(collections, ["WorkshopProjects", "WorkshopUnits"]);
});
