import assert from "node:assert/strict";
import test from "node:test";
import {
  atPath,
  presentation,
  readableProgram,
  summary,
} from "../src/lib/node-presentation";
import {
  readerBody,
  readerFixture,
  controlPresentation,
} from "../fixtures/node-reader";

test("schema presentation is optional and resolves only own properties", () => {
  assert.equal(
    presentation({ jsonSchema: { "x-wiki-presentation": { version: 99 } } }),
    undefined,
  );
  assert.equal(atPath({}, "constructor.prototype"), undefined);
  assert.equal(atPath(readerBody, "sources"), readerBody.sources);
  assert.equal(summary(readerFixture().nodes[0]), readerBody.description);
});
test("operator previews and decision rows come from the stored program", () => {
  const labels = controlPresentation.inputLabels;
  const result = readableProgram(readerBody.programs.measurement, labels);
  assert.match(result.expression, /First qualifying response.*−.*Issue opened/);
  assert.match(result.expression, /÷ 3600/);
  const decision = readableProgram(readerBody.programs.decision, labels);
  assert.deepEqual(
    decision.decisions.map((row) => row.result),
    ["Unknown", "Met", "Breached", "Pending"],
  );
  assert.match(decision.decisions[1].condition, /≤/);
  assert.match(
    readableProgram([
      {
        name: "bad",
        operator: "add",
        arguments: [{ step: "missing" }, { value: 1 }],
      },
    ]).expression,
    /Unknown step/,
  );
});
