import assert from "node:assert/strict";
import test from "node:test";
import { plainText } from "../src/lib/plain-text";

test("card summaries are one bounded line without markup", () => {
  assert.equal(
    plainText("## Plan\n**Ship** <em>v1</em> — see [notes](https://x.test)\u0007", 200),
    "Plan Ship v1 — see notes",
  );
  assert.equal(plainText("a".repeat(300), 10), `${"a".repeat(9)}…`);
  assert.equal(plainText("  ***  ", 10), "");
});
