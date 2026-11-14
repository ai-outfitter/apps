import assert from "node:assert/strict";
import test from "node:test";
import { demonstrationBody, evidenceBundleOperations, type EvidenceBundleInput } from "../src/evidence-bundle";
import { edgeInput, nodeInput, typeInput } from "../src/graph-contracts/index";
import standard from "../graph/standard-types.json" with { type: "json" };

const types = (standard as { id: string; name: string; category: "node" | "edge" }[]).map(({ id, name, category }) => ({ id, name, category }));
const url = (n: number) => `https://software-foundry.acme.ai-outfitter.com/files/main/evidence/ios-run/${n}.png`;
const input = (overrides: Partial<EvidenceBundleInput> = {}): EvidenceBundleInput => ({
  types,
  document: { id: "07191fef-42bc-54d9-8bc7-01bd1d8be3a2", slug: "ios-run-evidence", title: "iOS run", body: "# iOS run" },
  projectNodeId: "4731d6de-bcb0-42b2-a968-5b79b2422d6f",
  subject: { id: "8ce20301-ff32-4bbb-8c88-8c4d03bbda3d", revision: 1 },
  environment: "Simulator, fixture API",
  capturedAt: "2026-11-14T05:26:59Z",
  limitations: ["Simulator only."],
  steps: [{ title: "Office", url: url(1) }, { title: "Confirmed", url: url(2), caption: "After relaunch" }],
  ...overrides,
});

test("a bundle becomes a Document, numbered Demonstrations, includes_record edges and a documents edge to the Project", async () => {
  const ops = await evidenceBundleOperations(input());
  assert.deepEqual(ops.map((op) => op.ref), [
    "$evidence-bundle",
    "$evidence-step-1", "$evidence-includes-step-1",
    "$evidence-step-2", "$evidence-includes-step-2",
    "$evidence-documents-project",
  ]);
  const step = ops[3].attributes;
  assert.equal(step.title, "2. Confirmed");
  assert.equal(step.summary, "After relaunch");
  const body = demonstrationBody.parse(JSON.parse(step.body as string));
  assert.deepEqual(body.media, [url(2)]);
  assert.deepEqual(ops[4].attributes, { ...ops[4].attributes, fromId: input().document.id, toId: step.id, properties: { record_revision: 1, role: "demonstration" } });
  assert.equal(ops.at(-1)?.attributes.toId, input().projectNodeId);
  // Stable IDs: the same bundle names the same records.
  assert.deepEqual(await evidenceBundleOperations(input()), ops);
});

test("types are found by name, so a graph whose standard ID belongs to another type still works", async () => {
  const sunny = types.filter((type) => type.name !== "includes_record").concat({ id: "7b000000-0000-4000-8000-000000000004", name: "DesignArtifact", category: "node" });
  const ops = await evidenceBundleOperations(input({ types: sunny }));
  assert.equal(ops[0].ref, "$includes-record-type");
  const typeId = ops[0].attributes.id;
  assert.notEqual(typeId, "7b000000-0000-4000-8000-000000000004");
  assert.ok(ops.filter((op) => op.ref.startsWith("$evidence-includes")).every((op) => op.attributes.typeId === typeId));
});

test("an existing Document is linked, not created again", async () => {
  const ops = await evidenceBundleOperations(input({ document: { ...input().document, existing: true } }));
  assert.equal(ops.some((op) => op.ref === "$evidence-bundle"), false);
});

test("a graph without Document, Demonstration or documents says Planning cannot show the bundle", async () => {
  await assert.rejects(evidenceBundleOperations(input({ types: types.filter((type) => type.name !== "Demonstration") })), /no node type named Demonstration/);
});

test("steps need https screenshot URLs; the Demonstration body refuses extra keys", async () => {
  await assert.rejects(evidenceBundleOperations(input({ steps: [{ title: "Office", url: "screenshots/1.png" }] })));
  assert.equal(demonstrationBody.safeParse({ ...JSON.parse((await evidenceBundleOperations(input()))[1].attributes.body as string), result: "1 passed" }).success, false);
});

test("every proposal passes the graph record contracts Onto validates", async () => {
  const sunny = types.filter((type) => type.name !== "includes_record");
  for (const op of await evidenceBundleOperations(input({ types: sunny }))) {
    const contract = { "graph-type": typeInput, "graph-node": nodeInput, "graph-edge": edgeInput }[op.type];
    const parsed = contract.safeParse(op.attributes);
    assert.ok(parsed.success, `${op.ref}: ${parsed.error?.message}`);
  }
});
