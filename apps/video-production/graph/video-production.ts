import type { AuthoredGraph } from "@ai-outfitter/app-sdk/graph-authoring";

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

export const videoTypes = {
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
    edge(videoTypeIds.promotes, "promotes", "Promotes", "The product or offering a creative brief is for.", ["video-production:CreativeBrief"], ["onto:Product", "onto:Offering"]),
    edge(videoTypeIds.followsBrief, "follows_brief", "Follows brief", "The creative brief a storyboard follows.", ["video-production:Storyboard"], ["video-production:CreativeBrief"]),
    edge(videoTypeIds.shotOf, "shot_of", "Shot of", "The storyboard a shot belongs to. Its order is the shot's sequence property.", ["video-production:Shot"], ["video-production:Storyboard"]),
    edge(videoTypeIds.usesReference, "uses_reference", "Uses reference", "A visual reference the shot must match.", ["video-production:Shot"], ["video-production:VisualReference"]),
    edge(videoTypeIds.cutFrom, "cut_from", "Cut from", "The longer storyboard a shorter cut is made from.", ["video-production:Storyboard"], ["video-production:Storyboard"]),
  ],
  nodes: [],
  edges: [],
} satisfies Pick<AuthoredGraph, "types" | "nodes" | "edges">;
