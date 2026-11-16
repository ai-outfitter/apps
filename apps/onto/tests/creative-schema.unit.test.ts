import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import seed from "../seeds/creative-v1.json";
import { creativeSchemas } from "../src/server/creative";
test("creative graph body constraints match mutation validation and immutable provenance applies to generic writes", () => {
  for (const [name, schema] of Object.entries(creativeSchemas))
    assert.deepEqual(
      seed.types.find((t) => t.name === name)?.jsonSchema,
      z.toJSONSchema(schema),
      name,
    );
  for (const name of [
    "GenerationSnapshot",
    "CreativeCandidate",
    "CreativeFeedback",
  ])
    assert.equal(
      seed.types.find((t) => t.name === name)?.ontology?.immutable,
      true,
      name,
    );
});
