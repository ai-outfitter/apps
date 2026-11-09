import assert from "node:assert/strict";
import test from "node:test";
import { documentSchema } from "@ai-outfitter/app-sdk/agent-schema";
import { standardData } from "../src/lib/standard-data";
import {
  parseKnowledgeGraph,
  resolveKnowledgeGraph,
} from "../src/lib/knowledge-graphs";

const release = standardData.types.find((type) => type.name === "Release");
const draft = {
  stage: "draft",
  headline: "Every agent on your team works from the same map of your organization.",
  subheadline: "Founders and small teams get one shared workspace.",
  customer: "Independent builders managing multiple projects.",
  problem: "Each agent session starts from zero.",
  solution: "A shared Wiki every connected agent can read and update.",
  gettingStarted: "Create an organization and connect your agent.",
  inScope: [{ statement: "Connect your own agent" }],
  outOfScope: [{ statement: "Inference credits", reason: "Later release" }],
  customerQuote: { text: "It already knows our goals.", persona: "Independent builder", hypothetical: true },
  openQuestions: ["Are resident agents in scope?"],
};

test("every Wiki seeds a Release type whose body is a working-backwards press release", () => {
  assert.ok(release?.jsonSchema);
  const schema = documentSchema(release.jsonSchema);
  assert.deepEqual(schema.parse(draft), draft);
  for (const field of ["customer", "problem", "inScope", "outOfScope"]) {
    const missing: Record<string, unknown> = { ...draft };
    delete missing[field];
    assert.throws(() => schema.parse(missing), `${field} is required`);
  }
  assert.throws(() => schema.parse({ ...draft, stage: "maybe" }));
  assert.throws(() =>
    schema.parse({ ...draft, outOfScope: [{ statement: "No reason" }] }),
  );
});

test("release edges start at a Release and the scope view resolves", () => {
  const edges = ["announces", "for_customer", "in_scope", "out_of_scope", "delivered_as"];
  for (const name of edges)
    assert.ok(standardData.types.some((type) => type.name === name && type.category === "edge"), name);
  const view = standardData.nodes.find((node) => node.slug === "release-scope");
  assert.ok(view);
  assert.deepEqual(JSON.parse(view.body).rootTypes, ["Release"]);
  resolveKnowledgeGraph(standardData, parseKnowledgeGraph(view));
  const artifact = standardData.nodes.find((node) => node.slug === "press-release");
  assert.ok(artifact);
  assert.ok(
    standardData.edges.some((edge) => edge.fromId === artifact.id && edge.toId === view.id),
    "Press release uses the Release scope view",
  );
});

const revision = standardData.types.find((type) => type.name === "ProductRevision");
const software = {
  stage: "candidate",
  sourceCommit: "a".repeat(40),
  buildId: "build-1",
  sourcePath: "",
  specification: { id: "77000000-0000-4000-8000-000000000006", revision: 1 },
  includedChanges: [],
};

test("a ProductRevision is a software revision pinning a commit or a hardware revision pinning a design", () => {
  assert.ok(revision?.jsonSchema);
  const schema = documentSchema(revision.jsonSchema);
  assert.deepEqual(schema.parse(software), software);
  const hardware = { stage: "concept", designKey: "hardware/snsp-1@0123abcd", targetDate: "2027-03" };
  assert.deepEqual(schema.parse(hardware), hardware);
  assert.throws(() => schema.parse({ ...software, stage: "idea" }));
  assert.throws(() => schema.parse({ ...software, sourceCommit: "main" }));
  assert.throws(() => schema.parse({ ...hardware, bom: [] }));
});

test("every Wiki seeds the product chain view; Workshop owns the hardware vocabulary", () => {
  const type = (name: string) => standardData.types.find((candidate) => candidate.name === name);
  const id = (name: string) => type(name)?.id;
  const component = type("PhysicalComponent");
  assert.deepEqual(component?.properties.map((property) => property.name), ["kind", "part_number", "manufacturer", "mpn", "datasheet"]);
  assert.deepEqual(type("for_customer")?.ontology, { version: 2, endpoints: { from: [id("Release"), id("Offering")], to: [id("CustomerSegment")] } });
  assert.match(String(type("supplied_by")?.body), /PhysicalComponent/);
  assert.equal(type("evidence_for")?.id, "7b000000-0000-4000-8000-000000000003");
  assert.deepEqual(type("evidence_for")?.ontology?.endpoints, { from: "any", to: "any" }, "evidence_for keeps its ends open: Planning links demonstrations to stories with it");
  for (const name of ["component_of", "includes_component", "DesignArtifact", "TelemetryStream"])
    assert.equal(type(name), undefined, `${name} is Workshop's`);
  const view = standardData.nodes.find((node) => node.slug === "product-chain");
  assert.ok(view);
  const body = JSON.parse(view.body);
  assert.deepEqual(body.rootTypes, ["Release"]);
  assert.deepEqual(body.selection.relationships.map((rule: { type: string }) => rule.type), ["delivered_as", "revision_of", "packages_product", "for_customer", "evidence_for"]);
  assert.ok(body.query && body.hash, "the seed carries its compiled query");
  resolveKnowledgeGraph(standardData, parseKnowledgeGraph(view));
});
