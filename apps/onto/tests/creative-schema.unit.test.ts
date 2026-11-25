import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defaultTypes } from "../src/lib/default-types";
import { creativeSchemas } from "../src/server/creative";
test("creative graph body constraints match mutation validation and immutable provenance applies to generic writes", () => {
  for (const [name, schema] of Object.entries(creativeSchemas))
    assert.deepEqual(
      defaultTypes.find((t) => t.name === name)?.jsonSchema,
      z.toJSONSchema(schema),
      name,
    );
  for (const name of [
    "GenerationSnapshot",
    "CreativeCandidate",
    "CreativeFeedback",
  ]) {
    const contract = defaultTypes.find(t => t.name === name)?.ontology;
    assert.ok(contract?.version === 2 && contract.immutable, name);
  }
});
