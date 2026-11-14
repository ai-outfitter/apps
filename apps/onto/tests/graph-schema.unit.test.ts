import assert from "node:assert/strict";
import test from "node:test";
import { standardGraphTypes, wikiGraphSchema } from "../scripts/graph-schema";

const run = "run node --import tsx apps/onto/scripts/graph-schema.ts";
test("the SDK's committed standard GraphQL schema and types match the seed types", async () => {
  assert.deepEqual(await standardGraphTypes({ check: true }), [], run);
});

test("the Wiki's committed change-batch schema and documents are current", async () => {
  assert.deepEqual(await wikiGraphSchema({ check: true }), [], run);
});
