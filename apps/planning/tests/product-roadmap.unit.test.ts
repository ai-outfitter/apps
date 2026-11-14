import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readProductRoadmap } from "../src/server/product-roadmap";

const record = (id: string, attributes: Record<string, unknown> = {}) => ({ ref: { id }, title: id, attributes, revision: 1 });
const json = (value: object) => JSON.stringify(value);
test("selects the current organization's latest quarterly roadmap and excludes foreign plans", async () => {
  const types = [record("control", { name: "DecisionControlV3" }), record("occurrence", { name: "ControlOccurrence" }), record("plan", { name: "Plan" })];
  const nodes = [
    record("c", { typeId: "control", body: json({ organization_id: "artera", kind: "product_strategy", schedule: { kind: "quarterly" } }) }),
    record("o1", { typeId: "occurrence", body: json({ organization_id: "artera", control_id: "c", document_id: "good", due_on: "2026-01-01" }) }),
    record("o2", { typeId: "occurrence", body: json({ organization_id: "artera", control_id: "c", document_id: "foreign", due_on: "2026-04-01" }) }),
    record("good", { typeId: "plan", body: json({ organization_id: "artera", kind: "product_roadmap_lifecycle", status: "draft", sections: [] }) }),
    record("foreign", { typeId: "plan", body: json({ organization_id: "other", kind: "product_roadmap_lifecycle", sections: [] }) }),
  ];
  const context = { apps: { database: async () => ({ collection: (name: string) => ({ list: async ({ where }: { where: { typeId?: string } }) => (name === "types" ? types : nodes.filter(n => n.attributes.typeId === where.typeId)), get: async (id: string) => nodes.find(n => n.ref.id === id) }) }) } };
  const result = await readProductRoadmap(await context.apps.database() as never, "artera");
  assert.equal(result?.id, "good");
  assert.equal(result?.status, "draft");
  assert.equal(await readProductRoadmap(await context.apps.database() as never, "other"), null);
});
