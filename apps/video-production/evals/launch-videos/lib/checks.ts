// Checks shared by the launch-video evals: one member request, run against separate
// Ontos (Sunny, Outfitter), that brings a new kind of record. Each Onto should reach
// the shape of Video production's types: a storyboard type, a shot type with order
// and duration properties and a typed shot → storyboard relationship. Names may differ.
import { expect, test } from "vitest";
import { analyze, type Operation, reference, timingInTitle } from "./analysis";
import { judge, run } from "./run";

const SHOTS = 8; // two videos, four shots each

const rootNode = () => (run().onto.after.graph_nodes ?? []).find((row) => {
  const properties = typeof row.properties === "string" ? JSON.parse(row.properties) : row.properties;
  return properties?.organization_id === "eval-org";
});

/** Everything connected to the root through saved or staged relationships, in either direction. */
function reachable(rootId: string, operations: Operation[]) {
  const nodes = run().onto.after.graph_nodes ?? [];
  // Staged edges name saved nodes by id or by address (Type:slug) and new ones by ref.
  const bySlug = new Map(nodes.map((row) => [String(row.slug), String(row.id)]));
  const handle = (value: unknown) => bySlug.get(String(value).split(":").pop() ?? "") ?? String(value);
  const pairs = [
    ...(run().onto.after.graph_edges ?? []).filter((row) => !row.archived).map((row) => [String(row.fromId), String(row.toId)]),
    ...operations.filter((op) => op.type === "graph-edge" && op.operation === "create").map((op) => [handle(op.attributes.fromId), handle(op.attributes.toId)]),
  ];
  const links = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const reached = new Set([rootId]);
  const queue = [rootId];
  for (let id = queue.shift(); id; id = queue.shift())
    for (const next of links.get(id) ?? [])
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
  return reached;
}

export function launchVideoChecks({ scope, products }: { scope: string; products: string[] }) {
  test("stages a batch in the organization's Onto", () => {
    const { batches, operations } = analyze(run());
    expect(batches.length, "no change batch was opened").toBeGreaterThan(0);
    expect(operations.length, "the batch is empty").toBeGreaterThan(0);
    const writes = run().calls.filter((call) => call.tool === "graph_mutate");
    expect(writes.every((call) => call.arguments.scope === scope), "wrote outside the organization").toBe(true);
  });

  test("proposes the reference shape: storyboard, shot with order and duration, shot → storyboard", () => {
    const { newTypes, shape, shots } = analyze(run());
    // Read the two Ontos' lines side by side: names may differ, the shape should not.
    console.log(`PROPOSED TYPES ${scope} ${JSON.stringify(newTypes)}`);
    console.log(`REFERENCE ${JSON.stringify(reference)}`);
    console.log(`SHAPE ${scope} ${JSON.stringify(shape)}`);
    expect(shots, "no node type carries both an order and a duration property").not.toEqual([]);
    expect(shape, "no typed relationship from the shot type to a storyboard type").not.toBeNull();
  });

  test("shots are records of a new type, not Documents", () => {
    const { typedRecords, documents } = analyze(run());
    expect(typedRecords.length, `${documents.length} Documents and ${typedRecords.length} records of a new type were staged`).toBeGreaterThanOrEqual(SHOTS);
  });

  test("order and duration are properties, not title text", () => {
    const { typedRecords } = analyze(run());
    const withValues = typedRecords.filter((op) => Object.keys((op.attributes.properties as Record<string, unknown> | undefined) ?? {}).length > 0);
    expect(withValues.length, "new-type records carry no properties").toBeGreaterThanOrEqual(SHOTS);
    const titled = typedRecords.filter((op) => timingInTitle.test(String(op.attributes.title)));
    expect(titled.map((op) => op.attributes.title), "order or duration is still written into titles").toEqual([]);
  });

  test("every new record reaches the organization's root", () => {
    const { operations } = analyze(run());
    const root = rootNode();
    expect(root, "the seed has no root Organization").toBeTruthy();
    const reached = reachable(String(root?.id), operations);
    const loose = operations.filter((op) => op.type === "graph-node" && op.operation === "create" && !reached.has(op.ref));
    expect(loose.map((op) => op.attributes.title), "records with no path to the root").toEqual([]);
  });

  test("Onto's review flags the missing type", () => {
    const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as { state: string; findings: { rule: string; message: string }[] } | null;
    const reviews = analyze(run()).batches.map((batch) => parse(batch.review));
    expect(reviews.filter((review) => review?.state === "complete").length, "no batch review finished").toBeGreaterThan(0);
    const flagged = reviews.flatMap((review) => review?.findings ?? []).filter((finding) => finding.rule.startsWith("type."));
    console.log(`ONTO REVIEW ${scope} ${JSON.stringify(reviews.map((review) => review && { state: review.state, findings: review.findings }))}`);
    expect(flagged.map((finding) => finding.rule), "Onto's review said nothing about types").not.toEqual([]);
  });

  test("anchors the batch to the root only", () => {
    const root = rootNode();
    const anchors = (value: unknown) => ((typeof value === "string" ? JSON.parse(value) : value) as string[] | null) ?? [];
    const extra = analyze(run()).batches.flatMap((batch) => anchors(batch.anchors)).filter((id) => id !== root?.id);
    expect(extra, "the agent chose anchors nobody asked for").toEqual([]);
  });

  test("judge: the new types match the reference shape and are minimal", async () => {
    const { operations, newTypes, nameOf } = analyze(run());
    const counts: Record<string, number> = {};
    for (const op of operations) if (op.type !== "graph-type") counts[nameOf(op.attributes.typeId)] = (counts[nameOf(op.attributes.typeId)] ?? 0) + 1;
    const verdict = await judge(
      "The staged records model a storyboard (one video) and its shots as their own record types with a typed relationship from shot to storyboard, with shot order and duration as properties, as the reference types do. Names may differ from the reference. There are no more new types than the request needs, and the videos are linked to the products they are for. Fail if storyboards or shots are generic Documents.",
      `Products: ${products.join(", ")}\nReference types: ${JSON.stringify(reference)}\nNew types proposed: ${JSON.stringify(newTypes)}\nRecords staged, by type: ${JSON.stringify(counts)}`,
    );
    expect(verdict, verdict.reason).toMatchObject({ pass: true });
  });
}
