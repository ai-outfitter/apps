// A synthetic Onto graph: one brief, a storyboard with four shots, a shorter cut and two
// visual references (one still a requirement). The demo pages and the browser spec read it.
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { standardTypeIds, videoTypes } from "../src/server/onto";

const installationId = "onto";
const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = (type: string, recordId: string, attributes: Record<string, unknown>): EntityRecord => ({
  ref: { installationId, type, id: recordId }, revision: 1, title: String(attributes.title ?? attributes.name), attributes: { id: recordId, ...attributes }, references: [],
});

const types = [
  ...videoTypes.types.map((type) => record("graph-type", type.id, type)),
  record("graph-type", standardTypeIds.product, { name: "Product", category: "node", title: "Products" }),
];
const node = (n: number, typeId: string, title: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  record("graph-node", id(n), { typeId, title, properties, summary: "", ...extra });
const [brief, storyboard, shot, reference, promotes, followsBrief, shotOf, usesReference, cutFrom] = videoTypes.types.map((type) => type.id);

const shots = [
  { n: 11, title: "Choose a place", sequence: 1, start: 0, duration: 3, beat: "hook", action: "A hand holds a pothos up to a dim corner, then a bright window.", voiceover: "Where will it grow best?", status: "ready" },
  { n: 12, title: "Scan the room", sequence: 2, start: 3, duration: 5, beat: "demo", action: "The phone sweeps the room; light readings appear.", voiceover: "Sunny reads the light in every spot.", status: "blocked" },
  { n: 13, title: "The best spot lights up", sequence: 3, start: 8, duration: 4, beat: "payoff", action: "The planner marks the shelf by the east window.", voiceover: "And shows you the best one.", status: "planned" },
  { n: 14, title: "Plant in place", sequence: 4, start: 12, duration: 3, beat: "close", action: "The pothos on the shelf, app logo.", voiceover: "Sunny. Find your spot.", status: "planned" },
];

export const demoGraph = {
  types,
  nodes: [
    node(1, standardTypeIds.product, "Sunny plant placement planner"),
    node(2, brief, "Sunny app launch", {
      audience: "People who keep buying plants that die in the wrong spot.", single_message: "Sunny tells you where a plant will grow best.",
      claim_boundary: "Light readings only. No claims about plant health outcomes.", call_to_action: "Download the app.", success_metric: "Installs from the launch posts.", status: "approved",
    }, { slug: "sunny-app-launch" }),
    node(3, storyboard, "Find your spot", { duration_seconds: 15, aspect_ratio: "9:16", variant: "Social", opening: "A plant held up to a dark corner.", status: "draft" },
      { slug: "find-your-spot", summary: "The planner finds the best place in a room for a plant." }),
    node(4, storyboard, "Find your spot, short cut", { duration_seconds: 6, aspect_ratio: "9:16", variant: "Bumper", opening: "The best spot lights up.", status: "draft" }, { slug: "find-your-spot-short" }),
    ...shots.map((s) => node(s.n, shot, s.title, {
      sequence: s.sequence, start_seconds: s.start, duration_seconds: s.duration, beat: s.beat, action: s.action, voiceover: s.voiceover, status: s.status, claim_status: "ok",
    })),
    node(21, reference, "Planner light map screen", { status: "needed", requirements: "The room scan with light readings, final UI.", version: "rev A" }),
    node(22, reference, "SNY-1 visual lock", { status: "locked", requirements: "Product colour and finish.", file_uri: "https://example.com/sny-1-rev-a.png", version: "rev A" }),
  ],
  edges: [
    record("graph-edge", id(101), { typeId: promotes, fromId: id(2), toId: id(1) }),
    record("graph-edge", id(102), { typeId: followsBrief, fromId: id(3), toId: id(2) }),
    record("graph-edge", id(103), { typeId: followsBrief, fromId: id(4), toId: id(2) }),
    record("graph-edge", id(104), { typeId: cutFrom, fromId: id(4), toId: id(3) }),
    // Listed out of order: the page sorts by sequence.
    ...[14, 12, 11, 13].map((n, i) => record("graph-edge", id(110 + i), { typeId: shotOf, fromId: id(n), toId: id(3) })),
    record("graph-edge", id(120), { typeId: usesReference, fromId: id(12), toId: id(21) }),
    record("graph-edge", id(121), { typeId: usesReference, fromId: id(13), toId: id(21) }),
    record("graph-edge", id(122), { typeId: usesReference, fromId: id(11), toId: id(22) }),
  ],
};
