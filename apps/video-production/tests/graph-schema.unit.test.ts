import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { graphSchema } from "../scripts/graph-schema";

test("the committed GraphQL schema, types and documents match what graph.graphql and graph.mutate serve", async () => {
  assert.deepEqual(await graphSchema({ check: true }), [], "run node --import tsx apps/video-production/scripts/graph-schema.ts");
  const committed = JSON.parse(await readFile(new URL("../graph/documents.json", import.meta.url), "utf8")) as { name: string; kind: string; hidden?: boolean }[];
  // Agents read Storyboards and write through StoryboardChanges, never the single page mutation.
  assert.deepEqual(committed.filter((row) => !row.hidden).map((row) => `${row.kind} ${row.name}`), ["mutation StoryboardChanges", "query Storyboards"]);
});
