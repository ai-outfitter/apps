import assert from "node:assert/strict";
import test from "node:test";
import { ontologyContract, recordValidity, typeInput, typeMeasures, validityFields } from "../src/index";

const measures = [
  { name: "measurement", expression: { op: "formula", language: "control-v1", fields: { measurement: "measurement_formula", unit: "unit" } } },
  { name: "openObligations", grain: "commitment", expression: { op: "count", of: "commitment", where: { property: "state", equals: "open" } } },
  { name: "total", unit: "USD", expression: { op: "sum", property: "price" } },
  { name: "current", expression: { op: "active", at: "now" } },
];

test("typeMeasures reads valid version 2 measures and ignores the rest", () => {
  assert.deepEqual(typeMeasures({ ontology: { version: 2, stereotype: "kind", measures } }).map((m) => m.name), ["measurement", "openObligations", "total", "current"]);
  for (const ontology of [undefined, { version: 1 }, { version: 2 }, { version: 2, measures: [{ name: "Bad", expression: { op: "count" } }] }])
    assert.deepEqual(typeMeasures({ ontology }), []);
});

test("the ontology contract stays additive and rejects measures outside the closed set", () => {
  assert.ok(ontologyContract.safeParse({ version: 2, stereotype: "event" }).success);
  assert.ok(ontologyContract.safeParse({ version: 2, measures }).success);
  assert.ok(typeInput.safeParse({ category: "node", name: "Thing", title: "Thing", body: "A thing." }).success);
  for (const bad of [
    [{ name: "x", expression: { op: "avg", property: "price" } }],
    [{ name: "x", expression: { op: "formula", language: "control-v1", fields: {} } }],
    [{ name: "x", expression: { op: "formula", language: "control-v1", fields: { body: "unit" } } }],
    [{ name: "x", expression: { op: "count" } }, { name: "x", expression: { op: "count" } }],
    [{ name: "x", expression: { op: "count", of: "pursues", direction: "both" } }],
  ]) assert.equal(ontologyContract.safeParse({ version: 2, measures: bad }).success, false, JSON.stringify(bad));
});

test("recordValidity prefers the validity column and tolerates property shapes", () => {
  assert.deepEqual(validityFields, { from: "validFrom", until: "validUntil" });
  const from = "2026-01-01T00:00:00Z", until = "2026-07-01T00:00:00Z";
  assert.deepEqual(recordValidity({ validity: { from, to: null }, properties: { validUntil: until } }), { validFrom: from, validUntil: null });
  assert.deepEqual(recordValidity({ properties: { validFrom: from, validUntil: until } }), { validFrom: from, validUntil: until });
  assert.deepEqual(recordValidity({ properties: { valid_from: from, valid_until: until } }), { validFrom: from, validUntil: until });
  assert.deepEqual(recordValidity({ validity: null, properties: {} }), { validFrom: null, validUntil: null });
  assert.deepEqual(recordValidity({}), { validFrom: null, validUntil: null });
});
