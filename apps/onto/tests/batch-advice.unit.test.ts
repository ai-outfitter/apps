import assert from "node:assert/strict";
import test from "node:test";
import { batchAddInput } from "@ai-outfitter/app-sdk/graph-contracts";
import { demoGraph } from "../fixtures/graph";
import { core } from "../src/lib/graph";
import { type AdviceRow, adviceInstructions, batchAdvice, titlePatterns } from "../src/server/batch-advice";

// Onto's staging advice: plain checks that notice records needing a type, types that
// sprawl and cards that say nothing (docs/plans/missing-types.md).
const row = (ref: string, type: string, attributes: Record<string, unknown>, evidence: unknown[] = []): AdviceRow =>
  ({ ref, operation: { operation: "create", type, ref, attributes } as AdviceRow["operation"], evidence, state: "pending" });
const doc = (ref: string, title: string, extra: object = {}) => row(ref, "graph-node", { typeId: "Document", title, ...extra });
const edge = (ref: string, from: string, to: string, typeId = "part_of") => row(ref, "graph-edge", { typeId, fromId: from, toId: to });

/** The Sunny launch videos, as the agent staged them: every node a Document. */
function sunny() {
  const rows: AdviceRow[] = [doc("$packet", "Sunny launch packet")];
  const products = ["app", "sensor", "microgreens"];
  products.forEach((product, p) => {
    rows.push(doc(`$brief-${p}`, `${product} brief`), edge(`$brief-${p}-in`, `$brief-${p}`, "$packet"));
    for (const [c, length] of ["15s", "30s"].entries()) {
      const concept = `$concept-${p}-${c}`;
      rows.push(doc(concept, `Find your spot ${product} (${length})`), edge(`${concept}-in`, concept, `$brief-${p}`));
      for (const s of [1, 2]) rows.push(doc(`$shot-${p}-${c}-${s}`, `0${s} — Hook — choose a place / sunny-${product}-${length}`), edge(`$shot-${p}-${c}-${s}-in`, `$shot-${p}-${c}-${s}`, concept));
    }
  });
  return rows;
}

test("the Sunny batch trips the generic-cluster checks, each with a fix that can be staged as it is", () => {
  const advice = batchAdvice(demoGraph, sunny(), "batch-1");
  const clusters = advice.filter((item) => item.rule === "type.generic-cluster");
  // Briefs share a parent; concepts share a unit in brackets; shots share leading numbers.
  assert.equal(clusters.length, 3, JSON.stringify(advice.map((item) => item.message), null, 1));
  const briefs = clusters.find((item) => item.refs?.includes("$brief-0"))!;
  assert.deepEqual(briefs.refs, ["$brief-0", "$brief-1", "$brief-2"]);
  assert.match(briefs.message, /3 new Document records are part_of "Sunny launch packet"/);
  const briefTypes = briefs.stage!.proposals.map((proposal) => (proposal.operation as { attributes: { name: string; category: string } }).attributes);
  assert.deepEqual(briefTypes.map((type) => type.category), ["node", "edge"]);
  const concepts = clusters.find((item) => item.refs?.includes("$concept-0-0"))!;
  assert.equal(concepts.refs!.length, 6);
  const conceptType = (concepts.stage!.proposals[0].operation as { attributes: { properties: { name: string }[] } }).attributes;
  assert.deepEqual(conceptType.properties.map((property) => property.name), ["duration_seconds"]);
  const shots = clusters.find((item) => item.refs?.includes("$shot-0-0-1"))!;
  assert.equal(shots.refs!.length, 12);
  assert.deepEqual(shots.stage!.move, shots.refs);
  const shotType = (shots.stage!.proposals[0].operation as { attributes: { name: string; properties: { name: string }[] } }).attributes;
  assert.ok(shotType.properties.some((property) => property.name === "sequence"));
  // Every suggested proposal is a valid staging input, and its IDs are the same on the next call.
  for (const item of clusters) batchAddInput.shape.proposals.parse(item.stage!.proposals);
  assert.deepEqual(batchAdvice(demoGraph, sunny(), "batch-1"), advice);
  // The edge type names the new type and the parent's type as endpoints.
  const edgeType = (briefs.stage!.proposals[1].operation as { attributes: { ontology: { endpoints: { from: string[]; to: string[] } } } }).attributes;
  assert.deepEqual(edgeType.ontology.endpoints.from, [(briefs.stage!.proposals[0].operation as { attributes: { id: string } }).attributes.id]);
  assert.deepEqual(edgeType.ontology.endpoints.to, [core.document]);

  const edges = advice.find((item) => item.rule === "edge.generic-cluster")!;
  assert.equal(edges.refs!.length, 21);
  assert.match(edges.message, /part_of links Document → Document 21 times/);
  // Titles in a generic cluster are not reported twice.
  assert.equal(advice.filter((item) => item.rule === "property.in-title").length, 0);
  assert.equal(adviceInstructions("key", advice)[0].code, "CONSIDER_TYPES");
  assert.equal(adviceInstructions("key", advice)[0].required, false);
});

test("a number or ordinal in sibling titles of a real type is a property, with a type update to stage", () => {
  const project = demoGraph.types.find((type) => type.id === core.project)!;
  const rows = [1, 2, 3].map((n) => row(`$phase-${n}`, "graph-node", { typeId: core.project, title: `Phase ${n} rollout` }));
  const [finding] = batchAdvice(demoGraph, rows, "b").filter((item) => item.rule === "property.in-title");
  assert.deepEqual(finding.refs, ["$phase-1", "$phase-2", "$phase-3"]);
  assert.match(finding.fix!, /Add a sequence property to Project/);
  const update = finding.stage!.proposals[0].operation as { operation: string; id: string; revision: number; attributes: { properties: { name: string }[] } };
  assert.equal(update.operation, "update");
  assert.equal(update.id, "Project");
  assert.equal(update.revision, project.revision);
  assert.equal(update.attributes.properties.at(-1)!.name, "sequence");
  batchAddInput.shape.proposals.parse(finding.stage!.proposals);
});

test("type.sprawl: too many types, a type with too few records, and a type that repeats an existing one", () => {
  const component = demoGraph.types.find((type) => type.name === "PhysicalComponent")!;
  const type = (ref: string, name: string, properties: unknown[] = []) => row(ref, "graph-type", { category: "node", name, title: name, body: name, properties });
  const rows = [
    type("$t-a", "DomainConcept"), type("$t-b", "DataField"), type("$t-c", "DataGroup"), type("$t-d", "UseCase"),
    type("$t-e", "Part", component.properties),
    ...[1, 2, 3].flatMap((n) => [row(`$a-${n}`, "graph-node", { typeId: "$t-a", title: `Concept ${n}` }), row(`$b-${n}`, "graph-node", { typeId: "$t-b", title: `Field ${n}` }),
      row(`$c-${n}`, "graph-node", { typeId: "$t-c", title: `Group ${n}` })]),
    row("$d-1", "graph-node", { typeId: "UseCase", title: "Search" }),
  ];
  const sprawl = batchAdvice(demoGraph, rows, "b").filter((item) => item.rule === "type.sprawl");
  assert.match(sprawl[0].message, /creates 5 node types/);
  const few = sprawl.find((item) => item.ref === "$t-d")!;
  assert.match(few.message, /UseCase has only 1 record/);
  const same = sprawl.find((item) => item.ref === "$t-e" && item.severity === "warning")!;
  assert.match(same.message, /Part has the same properties as PhysicalComponent/);
  assert.match(same.fix!, /Use PhysicalComponent instead of Part/);
  assert.equal(sprawl.filter((item) => item.ref === "$t-a").length, 0);
});

test("card checks: summaries that repeat, boilerplate on many cards and long evidence quotes", () => {
  const boiler = "## Evidence and status\n\nThis record was imported from the engineering export and reflects the PDF page cited in its evidence; verify before use.";
  const rows = [
    doc("$title", "Scalar feature", { summary: "Scalar feature" }),
    doc("$body", "Vector feature", { summary: "A feature with an encoding but no index.", body: "## Facts\n\nA feature with an encoding but no index." }),
    ...[1, 2, 3, 4, 5, 6].map((n) => doc(`$card-${n}`, `Topic ${["red", "blue", "green", "gold", "teal", "rose"][n - 1]}`, { summary: `Why topic ${n} matters to us.`, body: boiler })),
    row("$quote", "graph-node", { typeId: "Document", title: "Quoted", summary: "Says something useful." }, [{ provider: "web", recordId: "page-103", quote: "x".repeat(400) }]),
  ];
  const advice = batchAdvice(demoGraph, rows, "b");
  assert.deepEqual(advice.find((item) => item.rule === "card.summary-repeats-title")?.ref, "$title");
  assert.deepEqual(advice.find((item) => item.rule === "card.summary-repeats-body")?.ref, "$body");
  const boilerplate = advice.find((item) => item.rule === "card.boilerplate")!;
  assert.equal(boilerplate.refs!.length, 6);
  assert.match(boilerplate.message, /same paragraph is on 6 cards/);
  assert.equal(advice.find((item) => item.rule === "evidence.quote-too-long")?.ref, "$quote");
  // Card advice alone asks for nothing.
  assert.deepEqual(adviceInstructions("key", advice), []);
});

test("an ordinary batch gets no advice", () => {
  const rows = [
    doc("$memo", "Pricing memo", { summary: "Why we moved to annual plans, for the board." }),
    row("$ada", "graph-node", { typeId: "Person", title: "Ada Lovelace", summary: "Advises on the analytics roadmap." }),
    doc("$notes", "Kickoff notes", { summary: "Decisions from the March kickoff." }),
    edge("$memo-of", "$memo", "$ada", "documents"),
  ];
  assert.deepEqual(batchAdvice(demoGraph, rows, "b"), []);
});

test("title patterns name the property they stand for", () => {
  assert.deepEqual(titlePatterns("Find your spot (15s)").map((item) => item.property), ["duration_seconds"]);
  assert.deepEqual(titlePatterns("01 — Hook — choose a place").map((item) => item.property), ["sequence"]);
  assert.deepEqual(titlePatterns("Step 3: wire it").map((item) => item.property), ["sequence"]);
  assert.deepEqual(titlePatterns("Teaser 30-second cut").map((item) => item.property), ["duration_seconds"]);
  assert.deepEqual(titlePatterns("Pricing memo"), []);
  assert.deepEqual(titlePatterns("2026 plan"), []);
});
