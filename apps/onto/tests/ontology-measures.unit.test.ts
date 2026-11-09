import assert from "node:assert/strict";
import test from "node:test";
import { typeMeasures, type OntologyV2 } from "@ai-outfitter/onto/contracts";
import { standardData } from "../src/lib/standard-data";
import { auditOntology } from "../src/lib/ontology-validation";
import { ontologyContext, v2 } from "../src/lib/ontology-model";
import { countTarget } from "../src/lib/ontology-measures";

const types = standardData.types;
const ctx = ontologyContext(standardData);
const byName = new Map(types.map((t) => [t.name, t]));
const named = (name: string) => { const type = byName.get(name); assert.ok(type, name); return type; };
const contract = (name: string) => v2(ctx.contracts.get(byName.get(name)?.id ?? "")) as OntologyV2;

test("every seed type parses with the extended ontology and the seed graph audits clean", () => {
  for (const type of types) if (type.ontology) assert.ok(ctx.contracts.has(type.id), type.name);
  assert.deepEqual(auditOntology(standardData), []);
});

test("declared endpoints and relator slots agree with existing types", () => {
  for (const type of types) {
    const declared = v2(ctx.contracts.get(type.id)) ?? ctx.contracts.get(type.id);
    if (type.category === "edge" && !v2(declared)?.projection) assert.ok(declared?.endpoints, `${type.name} declares endpoints`);
    const list = (side: unknown) => (Array.isArray(side) ? side as string[] : []);
    for (const id of [...list(declared?.endpoints?.from), ...list(declared?.endpoints?.to)])
      assert.equal(ctx.types.get(id)?.category, "node", `${type.name} endpoint ${id}`);
    for (const slot of v2(declared)?.participation?.slots ?? []) {
      const edge = ctx.types.get(slot.edgeTypeId);
      assert.equal(edge?.category, "edge", `${type.name}.${slot.name}`);
      const endpoints = ctx.contracts.get(slot.edgeTypeId)?.endpoints;
      assert.ok(endpoints, `${type.name}.${slot.name} edge declares endpoints`);
      assert.ok(Array.isArray(endpoints.from) && endpoints.from.includes(type.id), `${type.name}.${slot.name} from`);
      assert.deepEqual([...slot.participantTypes].sort(), [...list(endpoints.to)].sort(), `${type.name}.${slot.name} to`);
    }
  }
});

test("the seed declares six measures; the clean audit above covers their references", () => {
  assert.equal(types.flatMap((type) => typeMeasures(type)).length, 6);
});

test("seeded stereotypes, validity and measures keep their published names", () => {
  assert.equal(contract("Goal").stereotype, "kind");
  assert.equal(contract("MetricDefinition").stereotype, "kind");
  assert.equal(contract("DecisionRecord").stereotype, "event");
  assert.equal(contract("RoleAssignment").validity, "interval");
  assert.equal(contract("reports_to").validity, "interval");
  assert.deepEqual(contract("RoleAssignment").participation?.slots.map((s) => [s.name, ctx.types.get(s.edgeTypeId)?.name, s.min, s.max]),
    [["holder", "assigned_to", 0, 1], ["role", "assigns_role", 0, 1]]);
  assert.deepEqual(Object.fromEntries(["Goal", "MetricDefinition", "ControlDefinition", "ControlCommitment"].map((n) => [n, typeMeasures(byName.get(n) ?? {}).map((m) => m.name)])),
    { Goal: ["metrics", "pursuers"], MetricDefinition: ["measurement"], ControlDefinition: ["measurement", "commitments"], ControlCommitment: ["openObligations"] });
  // Other apps' types (a governing body, a business unit) pursue goals too, so any type may pursue one.
  assert.equal(ctx.contracts.get(named("pursues").id)?.endpoints?.from, "any");
  const obligations = countTarget(named("ControlCommitment"), { op: "count", of: "commitment" }, ctx);
  assert.equal(obligations !== "ambiguous" && obligations?.name, "ResponseObligation");
});

test("the validator rejects measures that name missing, ambiguous or non-numeric references", () => {
  const goal = named("Goal");
  type Row = (typeof types)[number];
  const audit = (measures: unknown, change: (t: Row) => Row = (t) => t, extra: Row[] = []) =>
    auditOntology({ ...standardData, types: [...types.map((t) => change(t.id === goal.id ? { ...t, ontology: { version: 2, stereotype: "kind", measures } as OntologyV2 } : t)), ...extra] })
      .filter((v) => v.recordId === goal.id).map((v) => v.rule);
  assert.deepEqual(audit([{ name: "x", expression: { op: "count", of: "nothing" } }]), ["measure.reference"]);
  assert.deepEqual(audit([{ name: "x", expression: { op: "count", of: "belongs_to_unit", direction: "outgoing" } }]), ["measure.reference"]);
  assert.deepEqual(audit([{ name: "x", expression: { op: "sum", property: "missing" } }]), ["measure.property"]);
  assert.deepEqual(audit([{ name: "x", expression: { op: "count", of: "pursues", where: { property: "missing", equals: "open" } } }]), ["measure.property"]);
  assert.deepEqual(audit([{ name: "x", expression: { op: "count", of: "pursues", where: { property: "status", equals: "documented" } } }]), []);
  // sum/min/max need a number property.
  const target = (type: "string" | "number") => (t: Row) => t.id === goal.id ? { ...t, properties: [{ name: "target", type, description: "Target value.", required: false }] } : t;
  assert.deepEqual(audit([{ name: "x", expression: { op: "max", property: "target" } }], target("string")), ["measure.property"]);
  assert.deepEqual(audit([{ name: "x", expression: { op: "max", property: "target" } }], target("number")), []);
  // Two relators whose slots (over one edge type) reach Goal: a shared slot name, or a slot named like an edge type, is ambiguous.
  const assignment = named("RoleAssignment"), holder = contract("RoleAssignment").participation?.slots[0];
  assert.ok(holder);
  const ids = ["71000000-0000-4000-8000-0000000000f1", "71000000-0000-4000-8000-0000000000f2"];
  const edge = ctx.contracts.get(holder.edgeTypeId);
  const reaching = (t: Row) => t.id === holder.edgeTypeId
    ? { ...t, ontology: { version: 2, endpoints: { from: [assignment.id, ...ids], to: [...(edge?.endpoints?.to ?? []), goal.id] } } as OntologyV2 } : t;
  const relators = (names: string[]) => names.map((slot, i) => ({ ...assignment, id: ids[i], name: `Relator${i}`, title: `Relator ${i}`,
    ontology: { version: 2, stereotype: "relator", participation: { slots: [{ ...holder, name: slot, participantTypes: [goal.id] }] } } as OntologyV2 }));
  const count = (of: string, slots: string[]) => audit([{ name: "x", expression: { op: "count", of } }], reaching, relators(slots));
  assert.deepEqual(count("sponsor", ["sponsor", "backer"]), []);
  assert.deepEqual(count("sponsor", ["sponsor", "sponsor"]), ["measure.reference"]);
  assert.deepEqual(count("pursues", ["pursues", "backer"]), ["measure.reference"]);
});
