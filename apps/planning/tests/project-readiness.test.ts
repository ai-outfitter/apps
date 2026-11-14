import test from "node:test";
import assert from "node:assert/strict";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { assessProjectReadiness } from "../src/project-readiness";

function required<T>(records: T[], predicate: (value: T) => boolean): T {
  const value = records.find(predicate);
  assert.ok(value, "Fixture record must exist");
  return value;
}

const record = (
  id: string,
  type: string,
  body: unknown = {},
  references: EntityRecord["references"] = [],
) =>
  ({
    ref: { installationId: "wiki", type: "graph-node", id },
    title: id,
    revision: 1,
    attributes: { typeId: type, body: JSON.stringify(body) },
    references,
  }) as EntityRecord;
function fixture() {
  const types = [
    "Project",
    "Problem",
    "UseCase",
    "Goal",
    "Product",
    "Offering",
    "Requirement",
    "AcceptanceCriterion",
    "ProductRevision",
    "Demonstration",
    "addresses",
    "has_use_case",
    "pursues",
    "produces",
    "packages_product",
    "has_requirement",
    "has_acceptance_criterion",
    "revision_of",
    "demonstrates",
  ].map((name) => ({ ...record(name, "type"), attributes: { name } }));
  const anchor = record("project", "Project", {}, [
    { installationId: "planning", type: "project", id: "p" },
  ]);
  const nodes = [
    anchor,
    record("problem", "Problem"),
    record("scenario", "UseCase", { actor: "Member", goal: "Finish a task" }),
    record("goal", "Goal"),
    record("product", "Product"),
    record("offering", "Offering"),
    record("requirement", "Requirement", {
      statement: "Save a task",
      rationale: "Avoid lost work",
      status: "approved",
    }),
    record("criterion", "AcceptanceCriterion", {
      condition: "A member saves",
      expectedOutcome: "The task survives reload",
    }),
  ];
  const edge = (fromId: string, type: string, toId: string) => ({
    ...record(`${fromId}-${type}-${toId}`, type),
    attributes: { typeId: type, fromId, toId },
  });
  const edges = [
    edge("project", "addresses", "problem"),
    edge("project", "has_use_case", "scenario"),
    edge("project", "pursues", "goal"),
    edge("project", "produces", "product"),
    edge("offering", "packages_product", "product"),
    edge("project", "has_requirement", "requirement"),
    edge("requirement", "has_acceptance_criterion", "criterion"),
  ];
  return {
    graph: { nodes, edges, types },
    edge,
    assess() {
      return assessProjectReadiness(this.graph, "planning", "p");
    },
  };
}
test("complete documented scope is advisory implementation-ready without claiming a demonstration", () => {
  const f = fixture(),
    result = f.assess();
  assert.equal(result.stage, "implement");
  assert.equal(result.priority, 1);
  assert.deepEqual(result.missing, []);
  assert.match(result.signals.join(" "), /no demonstration recorded/);
});
test("user and problem enable planning before requirements exist", () => {
  const f = fixture();
  f.graph.edges = f.graph.edges.filter(
    (e) =>
      !["has_requirement", "produces"].includes(String(e.attributes.typeId)),
  );
  const result = f.assess();
  assert.equal(result.stage, "plan");
  assert.equal(result.priority, 0);
  assert.ok(result.missing.some((m) => m.includes("requirements")));
});
test("prose and unrelated shared context never substitute for a linked user problem", () => {
  const f = fixture();
  f.graph.edges = f.graph.edges.filter(
    (e) => e.attributes.typeId !== "addresses",
  );
  f.graph.nodes[0].attributes.body = JSON.stringify({
    userStories: "A user has a problem",
  });
  assert.equal(f.assess().stage, "frame");
});
test("criteria coverage is independent of requirement approval", () => {
  const f = fixture();
  required(f.graph.nodes, (n) => n.ref.id === "requirement").attributes.body =
    JSON.stringify({ statement: "Save a task", status: "proposed" });
  const result = f.assess();
  assert.equal(result.stage, "plan");
  assert.ok(result.missing.some((m) => m.includes("approve")));
  assert.ok(!result.missing.some((m) => m.includes("structured acceptance")));
});
test("missing structured outcomes prevent implementation readiness", () => {
  const f = fixture();
  required(f.graph.nodes, (n) => n.ref.id === "criterion").attributes.body =
    JSON.stringify({ condition: "A member saves" });
  assert.equal(f.assess().stage, "plan");
});
test("another project's product and an archived product edge cannot improve priority", () => {
  const f = fixture();
  required(
    f.graph.edges,
    (e) => e.attributes.typeId === "produces",
  ).attributes.fromId = "another-project";
  assert.equal(f.assess().priority, 0);
  required(
    f.graph.edges,
    (e) => e.attributes.typeId === "produces",
  ).attributes.fromId = "project";
  Object.assign(
    required(f.graph.edges, (e) => e.attributes.typeId === "produces")
      .attributes,
    { archivedAt: 1 },
  );
  assert.equal(f.assess().priority, 0);
});
test("demonstration requires the matching revision, relationship and actual recorded media", () => {
  const f = fixture();
  const revision = record("revision", "ProductRevision");
  const demonstration = record("demo", "Demonstration", {
    subject: { id: "revision", revision: 2 },
    media: ["artifact.png"],
    environment: "Fixture",
    capturedAt: "2026-10-28T12:00:00Z",
  });
  f.graph.nodes.push(revision, demonstration);
  f.graph.edges.push(
    f.edge("revision", "revision_of", "product"),
    f.edge("demo", "demonstrates", "revision"),
  );
  assert.equal(f.assess().priority, 1);
  revision.revision = 2;
  assert.equal(f.assess().priority, 2);
  demonstration.attributes.body = JSON.stringify({
    subject: { id: "revision", revision: 2 },
    media: [],
    environment: "Fixture",
    capturedAt: "2026-10-28T12:00:00Z",
  });
  assert.equal(f.assess().priority, 1);
});
test("ambiguous canonical project links fail closed", () => {
  const f = fixture();
  f.graph.nodes.push({
    ...f.graph.nodes[0],
    ref: { ...f.graph.nodes[0].ref, id: "duplicate" },
  });
  assert.equal(f.assess().stage, "frame");
  assert.match(f.assess().missing[0], /ambiguous/);
});

test("offering context affects priority without blocking otherwise implementable internal work", () => {
  const f = fixture();
  f.graph.edges = f.graph.edges.filter(
    (e) => e.attributes.typeId !== "produces",
  );
  const result = f.assess();
  assert.equal(result.stage, "implement");
  assert.equal(result.priority, 0);
  assert.deepEqual(result.missing, []);
  assert.equal(result.priorityGaps.length, 2);
});

test("hiring work can be ready with observable criteria and no product or software artifacts", () => {
  const f = fixture();
  f.graph.edges = f.graph.edges.filter(
    (e) => e.attributes.typeId !== "produces",
  );
  required(f.graph.nodes, (n) => n.ref.id === "scenario").attributes.body =
    JSON.stringify({
      actor: "Hiring manager",
      goal: "Fill the approved operations role",
    });
  required(f.graph.nodes, (n) => n.ref.id === "requirement").attributes.body =
    JSON.stringify({
      statement: "Confirm the selected candidate meets the role requirements",
      status: "approved",
    });
  required(f.graph.nodes, (n) => n.ref.id === "criterion").attributes.body =
    JSON.stringify({
      condition: "The hiring panel completes its assessment",
      expectedOutcome:
        "The accountable manager records a supported hiring decision",
    });
  const result = f.assess();
  assert.equal(result.stage, "implement");
  assert.deepEqual(result.missing, []);
  assert.equal(result.priority, 0);
  assert.ok(result.evidence.some((e) => e.id === "criterion"));
});

test("association with an existing product is optional priority context, while using a tool is not", () => {
  const f = fixture();
  for (const name of ["part_of", "uses"])
    f.graph.types.push({ ...record(name, "type"), attributes: { name } });
  f.graph.edges = f.graph.edges.filter(
    (e) => e.attributes.typeId !== "produces",
  );
  const association = f.edge("project", "part_of", "product");
  f.graph.edges.push(association);
  assert.equal(f.assess().priority, 1);
  assert.equal(f.assess().stage, "implement");
  association.attributes.typeId = "uses";
  assert.equal(f.assess().priority, 0);
  association.attributes.typeId = "part_of";
  association.attributes.fromId = "another-project";
  assert.equal(f.assess().priority, 0);
});

test("archived graph fields exclude nodes, edges and type definitions from completeness and priority", () => {
  const archived = (
    f: ReturnType<typeof fixture>,
    group: "nodes" | "edges" | "types",
    id: string,
  ) => {
    Object.assign(required(f.graph[group], (n) => n.ref.id === id).attributes, {
      archived: true,
    });
  };
  const problem = fixture();
  archived(problem, "nodes", "problem");
  assert.equal(problem.assess().stage, "frame");
  const anchor = fixture();
  archived(anchor, "nodes", "project");
  assert.match(anchor.assess().missing[0], /Link this project/);
  const criterion = fixture();
  archived(criterion, "nodes", "criterion");
  assert.ok(
    criterion.assess().missing.some((m) => m.includes("structured acceptance")),
  );
  const edge = fixture();
  archived(edge, "edges", "requirement-has_acceptance_criterion-criterion");
  assert.ok(
    edge.assess().missing.some((m) => m.includes("structured acceptance")),
  );
  const type = fixture();
  archived(type, "types", "AcceptanceCriterion");
  assert.ok(
    type.assess().missing.some((m) => m.includes("structured acceptance")),
  );
  const product = fixture();
  archived(product, "types", "Product");
  assert.equal(product.assess().priority, 0);
});

test("retired structured relationship properties do not supply product context", () => {
  const f = fixture();
  Object.assign(
    required(f.graph.edges, (e) => e.attributes.typeId === "produces")
      .attributes,
    { properties: { status: "retired" } },
  );
  assert.equal(f.assess().priority, 0);
});

test("approval and criterion coverage are counted independently for each active requirement", () => {
  const f = fixture();
  required(f.graph.nodes, (n) => n.ref.id === "requirement").attributes.body =
    JSON.stringify({ statement: "Assess a candidate", status: "proposed" });
  f.graph.nodes.push(
    record("second-requirement", "Requirement", {
      statement: "Agree the start date",
      status: "approved",
    }),
  );
  f.graph.edges.push(
    f.edge("project", "has_requirement", "second-requirement"),
  );
  const result = f.assess();
  assert.equal(result.stage, "plan");
  assert.ok(
    result.signals.some(
      (s) =>
        s.includes("1/2 requirements approved") &&
        s.includes("1/2 with criteria"),
    ),
  );
  assert.ok(result.missing.some((m) => m.includes("approve 1")));
  assert.ok(result.missing.some((m) => m.includes("structured acceptance")));
});
