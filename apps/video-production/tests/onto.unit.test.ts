import assert from "node:assert/strict";
import test from "node:test";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { demoGraph } from "../fixtures/demo";
import { setupVideoTypes } from "../src/server/graph";
import { stageInput, standardTypeIds, storyboardProposals, storyboardsFromGraph, videoTypeIds, videoTypes } from "../src/server/onto";

test("the types keep the fixed IDs already staged in Sunny's Onto", () => {
  assert.deepEqual(Object.fromEntries(videoTypes.types.map((type) => [type.name, type.id])), {
    CreativeBrief: "c24f0c82-1b74-5e7b-b8b8-08d017132880",
    Storyboard: "ebeaaf8a-5028-583e-8179-b27344384cf9",
    Shot: "7964f188-e779-590e-a63d-301d9262e34a",
    VisualReference: "e968edf4-8dbb-505f-a817-86f05b3f6d11",
    promotes: "77f132c1-e18d-50ae-8de3-898d4e6b7933",
    follows_brief: "34b727d3-0685-5c2d-9255-bdc5969f41cd",
    shot_of: "1d339b61-ea5d-59fa-b680-e43852559315",
    uses_reference: "6b20c912-2687-57c7-9bf3-2f37c18c5c70",
    cut_from: "c3e79d23-8b94-585d-bd43-387966865cc9",
  });
  const properties = (name: string) => videoTypes.types.find((type) => type.name === name)!.properties.map((p) => `${p.name}:${p.type}${p.required ? "!" : ""}`);
  assert.deepEqual(properties("CreativeBrief"), ["audience:string", "single_message:string", "claim_boundary:string", "call_to_action:string", "success_metric:string", "status:string"]);
  assert.deepEqual(properties("Storyboard"), ["duration_seconds:number", "aspect_ratio:string", "variant:string", "opening:string", "status:string"]);
  assert.deepEqual(properties("Shot"), ["sequence:number!", "start_seconds:number", "duration_seconds:number", "beat:string", "action:string", "camera:string", "voiceover:string",
    "overlay:string", "sound:string", "transition:string", "source_route:string", "claim_status:string", "status:string"]);
  assert.deepEqual(properties("VisualReference"), ["status:string", "requirements:string", "file_uri:string", "version:string"]);
  assert.deepEqual(videoTypes.types.filter((type) => type.category === "node").map((type) => type.title), ["Creative briefs", "Storyboards", "Shots", "Visual references"]);
});

test("each relationship type names its endpoints", () => {
  const endpoints = Object.fromEntries(videoTypes.types.filter((type) => type.category === "edge").map((type) => [type.name, type.ontology?.endpoints]));
  assert.deepEqual(endpoints, {
    promotes: { from: [videoTypeIds.creativeBrief], to: [standardTypeIds.product, standardTypeIds.offering] },
    follows_brief: { from: [videoTypeIds.storyboard], to: [videoTypeIds.creativeBrief] },
    shot_of: { from: [videoTypeIds.shot], to: [videoTypeIds.storyboard] },
    uses_reference: { from: [videoTypeIds.shot], to: [videoTypeIds.visualReference] },
    cut_from: { from: [videoTypeIds.storyboard], to: [videoTypeIds.storyboard] },
  });
});

/** An in-memory Onto behind the entity host: IDs and type names are unique, as in Onto. */
function fakeOnto(seed: EntityRecord[] = []) {
  const records = new Map(seed.map((record) => [`${record.ref.type}:${record.ref.id}`, record]));
  const writes: string[] = [];
  const host = {
    async call(operation: string, input: Record<string, unknown>) {
      if (operation === "entities.get") {
        const found = records.get(`${input.type}:${input.id}`);
        if (!found) throw new Response("Not found", { status: 404 });
        return found;
      }
      if (operation === "entities.list") return [...records.values()].filter((record) => record.ref.type === input.type).slice(Number(input.offset ?? 0), Number(input.offset ?? 0) + Number(input.limit ?? 100));
      if (operation === "entities.create") {
        const attributes = input.attributes as Record<string, unknown> & { id: string };
        const clash = records.has(`${input.type}:${attributes.id}`) || (input.type === "graph-type" && [...records.values()].some((record) =>
          record.ref.type === "graph-type" && !record.attributes.archived && record.attributes.name === attributes.name && record.attributes.category === attributes.category));
        if (clash) throw new Response("Conflict", { status: 409 });
        const record: EntityRecord = { ref: { installationId: "onto", type: String(input.type), id: attributes.id }, revision: 1, title: String(attributes.title ?? attributes.name), attributes: attributes as EntityRecord["attributes"], references: [] };
        records.set(`${input.type}:${attributes.id}`, record);
        writes.push(`${input.type}:${attributes.name ?? attributes.id}`);
        return record;
      }
      throw new Error(`Unexpected ${operation}`);
    },
  };
  return { host: host as never, records, writes };
}

const typeRecord = (type: (typeof videoTypes.types)[number], attributes: Record<string, unknown> = {}): EntityRecord =>
  ({ ref: { installationId: "onto", type: "graph-type", id: type.id }, revision: 3, title: type.title, attributes: { ...type, ...attributes }, references: [] });

test("setup adds the types once and is a no-op the second time", async () => {
  const onto = fakeOnto();
  assert.deepEqual(await setupVideoTypes(onto.host, "onto"), { created: 9, existing: 0 });
  assert.deepEqual(await setupVideoTypes(onto.host, "onto"), { created: 0, existing: 9 });
  assert.equal(onto.writes.length, 9);
});

test("setup adopts types an Onto already has under the fixed IDs, without changing them", async () => {
  // Sunny's live copies: same IDs and names, their own wording.
  const live = videoTypes.types.map((type) => typeRecord(type, { body: "Written by hand in Sunny's Onto.", properties: [] }));
  const onto = fakeOnto(live);
  assert.deepEqual(await setupVideoTypes(onto.host, "onto"), { created: 0, existing: 9 });
  assert.deepEqual(onto.writes, []);
  assert.equal(onto.records.get(`graph-type:${videoTypeIds.shot}`)?.attributes.body, "Written by hand in Sunny's Onto.");
});

test("setup refuses a type at a fixed ID that is something else", async () => {
  const shot = videoTypes.types.find((type) => type.name === "Shot")!;
  const onto = fakeOnto([typeRecord(shot, { name: "Scene" })]);
  await assert.rejects(setupVideoTypes(onto.host, "onto"), (error: Response) => error.status === 409);
});

test("storyboards read in sequence order, with the references each shot needs", () => {
  const { briefs, unbriefed } = storyboardsFromGraph(demoGraph);
  assert.deepEqual(unbriefed, []);
  assert.equal(briefs.length, 1);
  assert.deepEqual(briefs[0].promotes.map((link) => link.title), ["Sunny plant placement planner"]);
  const board = briefs[0].storyboards.find((item) => item.address === "find-your-spot")!;
  assert.deepEqual(board.shots.map((shot) => [shot.sequence, shot.beat, shot.durationSeconds]), [[1, "hook", 3], [2, "demo", 5], [3, "payoff", 4], [4, "close", 3]]);
  assert.deepEqual(board.shots.map((shot) => shot.references.map((reference) => `${reference.title}${reference.hasFile ? "" : " (requirement)"}`)),
    [["SNY-1 visual lock"], ["Planner light map screen (requirement)"], ["Planner light map screen (requirement)"], []]);
  assert.equal(briefs[0].storyboards.find((item) => item.address === "find-your-spot-short")?.cutFrom?.title, "Find your spot");
});

const request = () => stageInput.parse({
  brief: { key: "app-launch", title: "App launch", single_message: "Find the best spot.", promotes: [demoGraph.nodes[0].ref.id] },
  storyboard: { key: "spot-15", title: "Find your spot", duration_seconds: 15, aspect_ratio: "9:16" },
  references: [{ key: "light-map", title: "Light map screen", requirements: "Final UI" }],
  shots: [
    { key: "hook", title: "Choose a place", sequence: 1, start_seconds: 0, duration_seconds: 3, beat: "hook", references: ["light-map"] },
    { key: "close", title: "Plant in place", sequence: 2, start_seconds: 3, duration_seconds: 3, beat: "close" },
  ],
});
const ids = async (kind: string, key: string) => `${kind}:${key}`;

test("a save proposes typed records and their links, with order and timing as properties", async () => {
  const { proposals } = await storyboardProposals(demoGraph, request(), ids, "evidence");
  const nodes = proposals.filter((p) => p.operation.type === "graph-node").map((p) => p.operation.attributes);
  assert.deepEqual(nodes.map((node) => node.typeId), [videoTypeIds.creativeBrief, videoTypeIds.storyboard, videoTypeIds.visualReference, videoTypeIds.shot, videoTypeIds.shot]);
  assert.deepEqual(nodes[3].properties, { sequence: 1, start_seconds: 0, duration_seconds: 3, beat: "hook" });
  const edges = proposals.filter((p) => p.operation.type === "graph-edge").map((p) => [p.operation.attributes.typeId, p.operation.attributes.fromId, p.operation.attributes.toId]);
  assert.deepEqual(edges, [
    [videoTypeIds.promotes, "$brief-app-launch", demoGraph.nodes[0].ref.id],
    [videoTypeIds.followsBrief, "$storyboard-spot-15", "$brief-app-launch"],
    [videoTypeIds.shotOf, "$shot-hook", "$storyboard-spot-15"],
    [videoTypeIds.usesReference, "$shot-hook", "$reference-light-map"],
    [videoTypeIds.shotOf, "$shot-close", "$storyboard-spot-15"],
  ]);
});

test("a save proposes nothing the Onto already has", async () => {
  const first = await storyboardProposals(demoGraph, request(), ids, "evidence");
  const created = first.proposals.map((p) => p.operation);
  const byRef = new Map(created.filter((op) => op.type === "graph-node").map((op) => [op.ref, String(op.attributes.id)]));
  const record = (type: string, attributes: Record<string, unknown>): EntityRecord =>
    ({ ref: { installationId: "onto", type, id: String(attributes.id) }, revision: 1, title: String(attributes.title ?? ""), attributes: attributes as EntityRecord["attributes"], references: [] });
  const committed = {
    types: demoGraph.types,
    nodes: [...demoGraph.nodes, ...created.filter((op) => op.type === "graph-node").map((op) => record("graph-node", op.attributes))],
    edges: [...demoGraph.edges, ...created.filter((op) => op.type === "graph-edge").map((op) => record("graph-edge", {
      ...op.attributes, fromId: byRef.get(String(op.attributes.fromId)) ?? op.attributes.fromId, toId: byRef.get(String(op.attributes.toId)) ?? op.attributes.toId,
    }))],
  };
  assert.deepEqual((await storyboardProposals(committed, request(), ids, "evidence")).proposals, []);
});

test("order and timing in a title are refused", () => {
  for (const title of ["01 — Hook", "Find your spot (15s)"])
    assert.equal(stageInput.safeParse({ ...request(), storyboard: { key: "x", title } }).success, false, title);
});
