import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/creative-team/scripts/graph-schema.ts");
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8"));
  assert.deepEqual(committed.filter((row: { kind: string }) => row.kind === "mutation").map((row: { name: string }) => row.name), [
    "AddMapBranch", "BrandChanges", "ContentChanges", "DeleteDraft", "DeleteMapNode", "DeleteSource", "DraftChanges", "MapChanges", "SaveBrandAnswer",
    "SaveContentProfile", "SaveDraft", "SaveMapNode", "SaveSource", "StageBrandInterview",
  ]);
  // Outside agents see the reads and the batch writes, never the single-record page mutations.
  assert.deepEqual(committed.filter((row: { hidden?: boolean }) => !row.hidden).map((row: { name: string }) => row.name), [
    "BrandAnswers", "BrandChanges", "BrandQuestions", "BrandWikiBatches", "ContentChanges", "ContentProfiles", "DraftChanges", "Drafts", "MapChanges", "MapNodes", "Sources",
  ]);
});
