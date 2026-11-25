import assert from "node:assert/strict";
import test from "node:test";
import type { TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { standardGraphTypes, wikiGraphSchema } from "../scripts/graph-schema";

const run = "run node --import tsx apps/onto/scripts/graph-schema.ts";
test("the SDK's generated standard GraphQL schema and types match all app contributions", async () => {
  assert.deepEqual(await standardGraphTypes({ check: true }), [], "run npm run graph:compose");
});

test("the Wiki's committed change-batch schema and documents are current", async () => {
  assert.deepEqual(await wikiGraphSchema({ check: true }), [], run);
});

test("a Wiki's schema is built once per set of type rows, and only the last few are kept", async () => {
  const { graphSchema } = await import("../src/server/graph-graphql");
  const rows = (title: string): TypeRow[] => [{ id: "t-1", name: "Gadget", category: "node", title, revision: 1 }];
  const built = await graphSchema(rows("Gadgets"));
  assert.ok(built.getQueryType()?.getFields().gadgets && built.getQueryType()?.getFields().changeBatches);
  assert.equal(await graphSchema(rows("Gadgets")), built, "the same rows reuse the schema");
  // Another Wiki's type with the same ID and revision is another schema: the whole row decides it.
  const other = await graphSchema(rows("Other gadgets"));
  assert.notEqual(other, built);
  assert.equal(other.getType("Gadget")?.description, "Other gadgets");
  for (let n = 0; n < 8; n++) await graphSchema(rows(`Wiki ${n}`));
  assert.notEqual(await graphSchema(rows("Gadgets")), built, "an evicted schema is built again");
});
