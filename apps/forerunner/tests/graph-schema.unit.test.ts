import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/forerunner/scripts/graph-schema.ts");
  // Every document is a mutation a route runs, or a query a page or agent reads with.
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.map((row: { name: string; kind: string }) => [row.name, row.kind]),
    [["Board", "query"], ["CreateItem", "mutation"], ["DeleteItem", "mutation"], ["DiscoveryRecords", "query"], ["ItemChanges", "mutation"], ["Items", "query"], ["ReorderItems", "mutation"], ["SetDailyRun", "mutation"], ["SuggestionChanges", "mutation"], ["Suggestions", "query"], ["UpdateItem", "mutation"], ["UpdateSuggestion", "mutation"]]);
  // Platform Schedules and WorkflowRuns serve workflows to MCP clients; Forerunner publishes only its suggestions.
  assert.deepEqual(committed.filter((row: { hidden?: boolean }) => !row.hidden).map((row: { name: string }) => row.name), ["SuggestionChanges", "Suggestions"]);
});
