import test from "node:test";
import assert from "node:assert/strict";
import { parse, validate } from "graphql";
import { graphqlSchema, documents } from "../src/server/graphql";
test("published creative documents validate", () => {
  for (const doc of Object.values(documents))
    assert.deepEqual(
      validate(
        graphqlSchema,
        parse(
          typeof doc.document === "string"
            ? doc.document
            : String(doc.document),
        ),
      ),
      [],
    );
});
