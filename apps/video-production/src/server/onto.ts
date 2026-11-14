// The video production ontology in the organization's Onto: creative briefs, storyboards,
// shots and the visual references shots must match. The types have fixed IDs, the same in
// every Onto, so an Onto that already has them (Sunny's, staged by hand first) is adopted
// as it is. Setup is add-only and never changes a type that exists.
import { z } from "zod";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";

/** Fixed IDs, the same in every Onto. */
export const videoTypeIds = {
  creativeBrief: "c24f0c82-1b74-5e7b-b8b8-08d017132880",
  storyboard: "ebeaaf8a-5028-583e-8179-b27344384cf9",
  shot: "7964f188-e779-590e-a63d-301d9262e34a",
  visualReference: "e968edf4-8dbb-505f-a817-86f05b3f6d11",
  promotes: "77f132c1-e18d-50ae-8de3-898d4e6b7933",
  followsBrief: "34b727d3-0685-5c2d-9255-bdc5969f41cd",
  shotOf: "1d339b61-ea5d-59fa-b680-e43852559315",
  usesReference: "6b20c912-2687-57c7-9bf3-2f37c18c5c70",
  cutFrom: "c3e79d23-8b94-585d-bd43-387966865cc9",
} as const;

/** Onto's standard Product and Offering types. */
export const standardTypeIds = { product: "71000000-0000-4000-8000-000000000015", offering: "71000000-0000-4000-8000-000000000056" } as const;

const text = (name: string, description: string) => ({ name, type: "string" as const, description, required: false });
const number = (name: string, description: string, required = false) => ({ name, type: "number" as const, description, required });
const status = (description: string) => text("status", description);
const edge = (id: string, name: string, title: string, body: string, from: string[], to: string[]) =>
  ({ id, category: "edge" as const, name, title, body, properties: [], ontology: { version: 2 as const, endpoints: { from, to } } });

export const videoTypes = wikiGraph.parse({
  types: [
    {
      id: videoTypeIds.creativeBrief, category: "node", name: "CreativeBrief", title: "Creative briefs",
      body: "Who a piece of marketing is for and what it may say. Link it to the products or offerings it promotes; storyboards follow it.",
      properties: [
        text("audience", "Who it is for, in a sentence."),
        text("single_message", "The one thing the audience should take away."),
        text("claim_boundary", "What it may and may not claim. Shots check their claims against this."),
        text("call_to_action", "What the audience should do next."),
        text("success_metric", "How the team will know it worked."),
        status("draft, approved or retired."),
      ],
    },
    {
      id: videoTypeIds.storyboard, category: "node", name: "Storyboard", title: "Storyboards",
      body: "The plan for one video: its shots in order, with timing. A storyboard is a plan, not evidence that the video exists. Length and variant are properties, never title text.",
      properties: [
        number("duration_seconds", "Planned length in seconds."),
        text("aspect_ratio", "Frame shape, such as 9:16 or 16:9."),
        text("variant", "Which cut this is, such as the 15-second social cut."),
        text("opening", "What the first second shows, to stop the scroll."),
        status("draft, approved, in_production or published."),
      ],
    },
    {
      id: videoTypeIds.shot, category: "node", name: "Shot", title: "Shots",
      body: "One beat of a storyboard. Order and timing are properties (sequence, start_seconds, duration_seconds), never title text. Link it to its storyboard and to the visual references it must match.",
      properties: [
        number("sequence", "Position in the storyboard, from 1.", true),
        number("start_seconds", "When the shot starts, in seconds from the start of the video."),
        number("duration_seconds", "How long the shot runs, in seconds."),
        text("beat", "Its job in the story: hook, demo, payoff or close."),
        text("action", "What we see."),
        text("camera", "Framing and movement."),
        text("voiceover", "What is said over it, word for word."),
        text("overlay", "On-screen text."),
        text("sound", "Music and effects."),
        text("transition", "How it cuts to the next shot."),
        text("source_route", "Where the footage comes from: filmed, screen capture, render or stock."),
        text("claim_status", "Whether its claim is within the brief's boundary: ok, check or blocked."),
        status("planned, blocked, ready or shot."),
      ],
    },
    {
      id: videoTypeIds.visualReference, category: "node", name: "VisualReference", title: "Visual references",
      body: "Something shots must match: a product render, a screen, a colour lock. A reference with no file is a requirement still to be made, not an asset.",
      properties: [
        status("needed, in_progress or locked."),
        text("requirements", "What it must show and how exact it must be."),
        text("file_uri", "Where the file is, once there is one. Empty means it is still a requirement."),
        text("version", "Which revision shots should match, such as rev A."),
      ],
    },
    edge(videoTypeIds.promotes, "promotes", "Promotes", "The product or offering a creative brief is for.", [videoTypeIds.creativeBrief], [standardTypeIds.product, standardTypeIds.offering]),
    edge(videoTypeIds.followsBrief, "follows_brief", "Follows brief", "The creative brief a storyboard follows.", [videoTypeIds.storyboard], [videoTypeIds.creativeBrief]),
    edge(videoTypeIds.shotOf, "shot_of", "Shot of", "The storyboard a shot belongs to. Its order is the shot's sequence property.", [videoTypeIds.shot], [videoTypeIds.storyboard]),
    edge(videoTypeIds.usesReference, "uses_reference", "Uses reference", "A visual reference the shot must match.", [videoTypeIds.shot], [videoTypeIds.visualReference]),
    edge(videoTypeIds.cutFrom, "cut_from", "Cut from", "The longer storyboard a shorter cut is made from.", [videoTypeIds.storyboard], [videoTypeIds.storyboard]),
  ],
  nodes: [],
  edges: [],
});

// The read model the pages and the Storyboards document serve.

export type Link = { id: string; address: string; title: string };
export type Reference = Link & { status: string; requirements: string; fileUri: string; version: string; hasFile: boolean };
export type Shot = Link & {
  sequence: number | null; startSeconds: number | null; durationSeconds: number | null;
  beat: string; action: string; camera: string; voiceover: string; overlay: string; sound: string; transition: string;
  sourceRoute: string; claimStatus: string; status: string;
  references: Reference[];
};
export type Storyboard = Link & {
  summary: string; durationSeconds: number | null; aspectRatio: string; variant: string; opening: string; status: string;
  brief: Link | null; cutFrom: Link | null; shots: Shot[];
};
export type Brief = Link & {
  summary: string; audience: string; singleMessage: string; claimBoundary: string; callToAction: string; successMetric: string; status: string;
  promotes: Link[]; storyboards: Storyboard[];
};
export type Storyboards = { briefs: Brief[]; unbriefed: Storyboard[] };

type Graph = { types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[] };

/** The Onto's ID for each of the app's types: the fixed ID, or the ID of a same-name type the
 * Onto had first (setup keeps that one). Product and Offering resolve the same way. */
export function resolveTypes(types: EntityRecord[]) {
  const live = types.filter((type) => !type.attributes.archived);
  const typeId = (id: string, name: string) => live.find((type) => type.ref.id === id)?.ref.id ?? live.find((type) => type.attributes.name === name)?.ref.id ?? id;
  return {
    brief: typeId(videoTypeIds.creativeBrief, "CreativeBrief"), storyboard: typeId(videoTypeIds.storyboard, "Storyboard"),
    shot: typeId(videoTypeIds.shot, "Shot"), reference: typeId(videoTypeIds.visualReference, "VisualReference"),
    promotes: typeId(videoTypeIds.promotes, "promotes"), followsBrief: typeId(videoTypeIds.followsBrief, "follows_brief"),
    shotOf: typeId(videoTypeIds.shotOf, "shot_of"), usesReference: typeId(videoTypeIds.usesReference, "uses_reference"), cutFrom: typeId(videoTypeIds.cutFrom, "cut_from"),
    product: typeId(standardTypeIds.product, "Product"), offering: typeId(standardTypeIds.offering, "Offering"),
  };
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Briefs with their storyboards, and each storyboard's shots in sequence order with the
 * references they need. Types resolve by their fixed ID, or by name when the Onto had a
 * type of that name before the app (setup keeps it).
 */
export function storyboardsFromGraph(graph: Graph): Storyboards {
  const active = <T extends EntityRecord>(rows: T[]) => rows.filter((row) => !row.attributes.archived);
  const ids = resolveTypes(graph.types);
  const nodes = new Map(active(graph.nodes).map((node) => [node.ref.id, node]));
  const edges = active(graph.edges);
  const ofType = (type: string) => [...nodes.values()].filter((node) => node.attributes.typeId === type);
  const targets = (type: string, fromId: string) => edges.filter((e) => e.attributes.typeId === type && e.attributes.fromId === fromId).map((e) => nodes.get(String(e.attributes.toId))).filter((n): n is EntityRecord => !!n);
  const sources = (type: string, toId: string) => edges.filter((e) => e.attributes.typeId === type && e.attributes.toId === toId).map((e) => nodes.get(String(e.attributes.fromId))).filter((n): n is EntityRecord => !!n);
  const props = (node: EntityRecord) => (node.attributes.properties ?? {}) as Record<string, unknown>;
  const link = (node: EntityRecord): Link => ({ id: node.ref.id, address: str(node.attributes.slug) || node.ref.id, title: node.title ?? str(node.attributes.title) });

  const reference = (node: EntityRecord): Reference => {
    const p = props(node);
    return { ...link(node), status: str(p.status), requirements: str(p.requirements), fileUri: str(p.file_uri), version: str(p.version), hasFile: !!str(p.file_uri) };
  };
  const shot = (node: EntityRecord): Shot => {
    const p = props(node);
    return {
      ...link(node), sequence: num(p.sequence), startSeconds: num(p.start_seconds), durationSeconds: num(p.duration_seconds),
      beat: str(p.beat), action: str(p.action), camera: str(p.camera), voiceover: str(p.voiceover), overlay: str(p.overlay), sound: str(p.sound),
      transition: str(p.transition), sourceRoute: str(p.source_route), claimStatus: str(p.claim_status), status: str(p.status),
      references: targets(ids.usesReference, node.ref.id).filter((n) => n.attributes.typeId === ids.reference).map(reference),
    };
  };
  const bySequence = (a: Shot, b: Shot) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.title.localeCompare(b.title);
  const storyboard = (node: EntityRecord): Storyboard => {
    const p = props(node);
    const brief = targets(ids.followsBrief, node.ref.id).find((n) => n.attributes.typeId === ids.brief);
    const cut = targets(ids.cutFrom, node.ref.id).find((n) => n.attributes.typeId === ids.storyboard);
    return {
      ...link(node), summary: str(node.attributes.summary), durationSeconds: num(p.duration_seconds), aspectRatio: str(p.aspect_ratio), variant: str(p.variant),
      opening: str(p.opening), status: str(p.status), brief: brief ? link(brief) : null, cutFrom: cut ? link(cut) : null,
      shots: sources(ids.shotOf, node.ref.id).filter((n) => n.attributes.typeId === ids.shot).map(shot).sort(bySequence),
    };
  };
  const byTitle = <T extends Link>(a: T, b: T) => a.title.localeCompare(b.title);
  const storyboards = ofType(ids.storyboard).map(storyboard).sort(byTitle);
  const briefs = ofType(ids.brief).map((node): Brief => {
    const p = props(node);
    return {
      ...link(node), summary: str(node.attributes.summary), audience: str(p.audience), singleMessage: str(p.single_message), claimBoundary: str(p.claim_boundary),
      callToAction: str(p.call_to_action), successMetric: str(p.success_metric), status: str(p.status),
      promotes: targets(ids.promotes, node.ref.id).map(link).sort(byTitle),
      storyboards: storyboards.filter((board) => board.brief?.id === node.ref.id),
    };
  }).sort(byTitle);
  return { briefs, unbriefed: storyboards.filter((board) => !board.brief) };
}

/** One storyboard by its address (slug) or ID. */
export function findStoryboard(model: Storyboards, address: string) {
  return [...model.briefs.flatMap((brief) => brief.storyboards), ...model.unbriefed].find((board) => board.address === address || board.id === address) ?? null;
}

// Staging: one change batch with a brief, a storyboard, its shots and their references.

/** Order and timing belong in properties. A title like "01 — Hook" or "Find your spot (15s)" carries them. */
export const timingInTitle = /^\s*\d+\s*[—–\-:.]|\(\s*\d+\s*s(ec(onds?)?)?\s*\)/i;
const title = z.string().trim().min(1).max(160).refine((value) => !timingInTitle.test(value), "Order and timing are properties, not title text");
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Your short stable name for this record, e.g. find-your-spot-15. The same key names the same record on a later save.");
const existing = z.uuid().optional().describe("An existing Onto record of this type to reuse instead of creating one (from Storyboards).");
const opt = (description: string) => z.string().trim().max(4000).optional().describe(description);
const seconds = (description: string) => z.number().min(0).max(36_000).optional().describe(description);

export const stageInput = z.strictObject({
  brief: z.strictObject({
    key, existingId: existing, title: title.optional().describe("Needed when creating the brief."),
    summary: z.string().trim().max(280).optional(),
    audience: opt("Who it is for."), single_message: opt("The one takeaway."), claim_boundary: opt("What it may and may not claim."),
    call_to_action: opt("What the audience should do next."), success_metric: opt("How the team will know it worked."), status: opt("draft, approved or retired."),
    promotes: z.array(z.uuid()).max(20).default([]).describe("Existing Product or Offering records the brief promotes."),
  }).refine((value) => value.existingId || value.title, "Name an existing brief or give a title"),
  storyboard: z.strictObject({
    key, existingId: existing, title: title.optional().describe("Needed when creating the storyboard. No length or variant in it."),
    summary: z.string().trim().max(280).optional(),
    duration_seconds: seconds("Planned length."), aspect_ratio: opt("Such as 9:16."), variant: opt("Which cut this is."),
    opening: opt("What the first second shows."), status: opt("draft, approved, in_production or published."),
    cutFrom: z.uuid().optional().describe("An existing Storyboard this one is a shorter cut of."),
  }).refine((value) => value.existingId || value.title, "Name an existing storyboard or give a title"),
  references: z.array(z.strictObject({
    key, existingId: existing, title: title.optional(), summary: z.string().trim().max(280).optional(),
    status: opt("needed, in_progress or locked."), requirements: opt("What it must show."), file_uri: opt("Where the file is. Leave out while it is a requirement."), version: opt("Revision to match."),
  }).refine((value) => value.existingId || value.title, "Name an existing reference or give a title")).max(40).default([]),
  shots: z.array(z.strictObject({
    key, title, summary: z.string().trim().max(280).optional(),
    sequence: z.number().int().min(1).max(500), start_seconds: seconds("Start, from the start of the video."), duration_seconds: seconds("How long it runs."),
    beat: opt("hook, demo, payoff or close."), action: opt("What we see."), camera: opt("Framing and movement."), voiceover: opt("Word for word."),
    overlay: opt("On-screen text."), sound: opt("Music and effects."), transition: opt("Cut to the next shot."),
    source_route: opt("filmed, screen capture, render or stock."), claim_status: opt("ok, check or blocked."), status: opt("planned, blocked, ready or shot."),
    references: z.array(key).max(20).default([]).describe("Keys of the references (above) this shot must match."),
  })).max(100).default([]),
});
export type StageInput = z.infer<typeof stageInput>;

export type Proposal = {
  operation: { operation: "create"; ref: string; type: "graph-node" | "graph-edge"; attributes: Record<string, unknown> };
  evidence: { provider: string; recordId: string }[];
  confidence: number;
  reason: string;
};

const propertyNames = (typeId: string) => new Set(videoTypes.types.find((type) => type.id === typeId)?.properties.map((p) => p.name) ?? []);
const pick = (fixedTypeId: string, values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([name, value]) => propertyNames(fixedTypeId).has(name) && value !== undefined && value !== ""));

/**
 * The proposals for one save: records the Onto does not have yet, and links it does not have
 * yet. Records it has are left as they are; change them in Onto. `id` derives a record's
 * stable ID from its kind and key.
 */
export async function storyboardProposals(graph: Graph, input: StageInput, id: (kind: string, key: string) => Promise<string>, evidenceId: string) {
  const nodes = new Map(graph.nodes.filter((node) => !node.attributes.archived).map((node) => [node.ref.id, node]));
  const edgeKeys = new Set(graph.edges.filter((edge) => !edge.attributes.archived).map((edge) => `${edge.attributes.typeId}:${edge.attributes.fromId}:${edge.attributes.toId}`));
  const typeOf = (nodeId: string) => String(nodes.get(nodeId)?.attributes.typeId ?? "");
  const t = resolveTypes(graph.types);
  const proposals: Proposal[] = [];
  const refs = new Map<string, string>();
  const evidence = [{ provider: "video-production", recordId: evidenceId }];
  const keys = new Set<string>();
  const unique = (kind: string, value: string) => {
    if (keys.has(`${kind}:${value}`)) throw new Response(`Duplicate ${kind} key ${value}`, { status: 400 });
    keys.add(`${kind}:${value}`);
  };

  const node = async (kind: string, fixedTypeId: string, typeId: string, item: { key: string; existingId?: string; title?: string; summary?: string }, properties: Record<string, unknown>, reason: string) => {
    unique(kind, item.key);
    if (item.existingId) {
      if (typeOf(item.existingId) !== typeId) throw new Response(`${item.existingId} is not an active ${kind} in this Onto`, { status: 409 });
      return item.existingId;
    }
    const nodeId = await id(kind, item.key);
    if (nodes.has(nodeId)) return nodeId;
    const ref = `$${kind}-${item.key}`;
    refs.set(nodeId, ref);
    proposals.push({ operation: { operation: "create", ref, type: "graph-node", attributes: { id: nodeId, typeId, title: item.title, summary: item.summary ?? "", properties: pick(fixedTypeId, properties) } }, evidence, confidence: 1, reason });
    return nodeId;
  };
  const link = async (typeId: string, fromId: string, toId: string, reason: string) => {
    const edgeKey = `${typeId}:${fromId}:${toId}`;
    if (edgeKeys.has(edgeKey)) return;
    edgeKeys.add(edgeKey);
    const edgeId = await id("link", edgeKey);
    proposals.push({ operation: { operation: "create", ref: `$link-${proposals.length}`, type: "graph-edge", attributes: { id: edgeId, typeId, fromId: refs.get(fromId) ?? fromId, toId: refs.get(toId) ?? toId } }, evidence, confidence: 1, reason });
  };

  const { brief: b, storyboard: s } = input;
  const briefId = await node("brief", videoTypeIds.creativeBrief, t.brief, b, b, "The creative brief the storyboard follows.");
  for (const productId of b.promotes) {
    if (![t.product, t.offering].includes(typeOf(productId))) throw new Response(`${productId} is not an active Product or Offering`, { status: 409 });
    await link(t.promotes, briefId, productId, "The brief is for this product.");
  }
  const boardId = await node("storyboard", videoTypeIds.storyboard, t.storyboard, s, s, "The plan for one video.");
  await link(t.followsBrief, boardId, briefId, "The storyboard follows this brief.");
  if (s.cutFrom) {
    if (typeOf(s.cutFrom) !== t.storyboard) throw new Response(`${s.cutFrom} is not an active Storyboard`, { status: 409 });
    await link(t.cutFrom, boardId, s.cutFrom, "A shorter cut of that storyboard.");
  }
  const references = new Map<string, string>();
  for (const item of input.references) references.set(item.key, await node("reference", videoTypeIds.visualReference, t.reference, item, item, item.file_uri ? "A visual reference shots must match." : "A visual reference shots need; no file yet."));
  const sequences = new Set<number>();
  for (const item of input.shots) {
    if (sequences.has(item.sequence)) throw new Response(`Two shots have sequence ${item.sequence}`, { status: 400 });
    sequences.add(item.sequence);
    const shotId = await node("shot", videoTypeIds.shot, t.shot, item, item, `Shot ${item.sequence} of the storyboard.`);
    await link(t.shotOf, shotId, boardId, "The shot belongs to this storyboard.");
    for (const referenceKey of item.references) {
      const referenceId = references.get(referenceKey);
      if (!referenceId) throw new Response(`Shot ${item.key} names unknown reference ${referenceKey}`, { status: 400 });
      await link(t.usesReference, shotId, referenceId, "The shot must match this reference.");
    }
  }
  return { proposals, storyboardId: boardId };
}
