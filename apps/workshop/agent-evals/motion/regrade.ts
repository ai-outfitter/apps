import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { grade } from "./grade";
import { fixtures, type FixtureId } from "./fixtures";

const file = process.argv[2];
if (!file) throw Error("Provide a Spark receipt JSON path");
type Receipt = { inputs: { fixture: FixtureId }; output: string; grade: { passed: boolean } };
const { receipts } = JSON.parse(await readFile(file, "utf8")) as { receipts: Receipt[] };
assert.deepEqual(receipts.map((entry) => entry.inputs.fixture).sort(), Object.keys(fixtures).sort());
for (const { inputs, output, grade: recorded } of receipts) {
  const result = grade(inputs.fixture, JSON.parse(output));
  console.log(JSON.stringify({ id: inputs.fixture, subject: "spark", ...result }));
  assert.equal(result.passed, recorded.passed, inputs.fixture);
}
