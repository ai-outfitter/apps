import { createHash } from "node:crypto";
import { AssemblySchema, type Item } from "../../src/lib/assembly";
import type { Operation } from "../../src/lib/operation-schema";
import { z } from "zod";

const vec = z.tuple([z.number(), z.number(), z.number()]);
type Vec = z.infer<typeof vec>;
type Part = { name: string; at: Vec; axis?: "slide-x" | "turn-z" | "turn-x"; size: Vec; color: string };
type Check = { label: string; part: string; time: number; point: Vec; expected: Vec };
const key = z.object({ time: z.number(), value: z.number() }).strict();
export const Answer = z.object({
  tracks: z.array(z.object({ part: z.string(), keys: z.array(key).min(2) }).strict()),
  couplings: z.array(z.object({ driver: z.string(), follower: z.string(), ratio: z.number() }).strict()),
  handoffs: z.array(z.object({ time: z.number(), prop: z.string(), carrier: z.string().nullable() }).strict()),
}).strict();
export type Answer = z.infer<typeof Answer>;

const track = (part: string, values: number[]): Answer["tracks"][number] =>
  ({ part, keys: values.map((value, time) => ({ time, value })) });
const check = (label: string, part: string, time: number, expected: Vec, point: Vec = [0, 0, 0]): Check =>
  ({ label, part, time, point, expected });
const part = (name: string, at: Vec, size: Vec, color: string, axis?: Part["axis"]): Part =>
  ({ name, at, size, color, axis });
function geometry({ size, axis }: Part): NonNullable<Item["geometry"]> {
  const [x, y, z] = size;
  const body = axis === "turn-z"
    ? { kind: "cylinder", axis: "z", base: [0, 0, -z / 2], radius: x / 2, height: z } as const
    : axis === "turn-x"
      ? { kind: "cylinder", axis: "x", base: [-x / 2, 0, 0], radius: y / 2, height: x } as const
      : { kind: "box", origin: [-x / 2, -y / 2, -z / 2], size } as const;
  const mark = axis === "turn-z"
    ? { kind: "box", origin: [x / 3, -1.5, z / 2 - 0.5], size: [3, 3, 1.5] } as const
    : axis === "turn-x"
      ? { kind: "box", origin: [-x / 3, y / 2 - 0.5, -0.5], size: [x * 2 / 3, 1.5, 1] } as const
      : undefined;
  return { version: 1, units: "mm", features: [
    { ...body, mode: "add" },
    ...(mark ? [{ ...mark, mode: "add" as const }] : []),
  ] };
}
type Fixture = {
  title: string;
  duration: number;
  playback: "once" | "loop";
  parts: Part[];
  reference: Answer;
  checks: Check[];
};

export const fixtures = {
  "spinning-wheel": {
    title: "Spinning wheel",
    duration: 2,
    playback: "loop",
    parts: [
      part("stand", [0, 0, 0], [48, 48, 3], "#78909c"),
      part("wheel", [0, 0, 7], [40, 40, 4], "#bd6743", "turn-z"),
      part("cap", [0, 0, 14], [10, 10, 2], "#445160"),
    ],
    reference: { tracks: [track("wheel", [0, 180, 360])], couplings: [], handoffs: [] },
    checks: [
      check("Quarter-turn witness", "wheel", 0.5, [0, 18, 7], [18, 0, 0]),
      check("Half-turn witness", "wheel", 1, [-18, 0, 7], [18, 0, 0]),
      check("One full turn", "wheel", 2, [18, 0, 7], [18, 0, 0]),
      check("Stationary axle cap", "cap", 1, [5, 0, 14], [5, 0, 0]),
    ],
  },
  "gear-pair": {
    title: "12:24 gear pair",
    duration: 2,
    playback: "once",
    parts: [
      part("base", [18, 0, 0], [80, 55, 3], "#78909c"),
      part("pinion", [0, 0, 8], [24, 24, 5], "#bd6743", "turn-z"),
      part("gear", [36, 0, 8], [48, 48, 5], "#5c99b4", "turn-z"),
    ],
    reference: {
      tracks: [track("pinion", [0, 180, 360])],
      couplings: [{ driver: "pinion", follower: "gear", ratio: -0.5 }],
      handoffs: [],
    },
    checks: [
      check("Pinion quarter turn", "pinion", 0.5, [0, 10, 8], [10, 0, 0]),
      check("Follower turns opposite", "gear", 1, [36, -22, 8], [22, 0, 0]),
      check("Follower ends at half turn", "gear", 2, [14, 0, 8], [22, 0, 0]),
    ],
  },
  "transfer-rig": {
    title: "Screw-driven transfer rig",
    duration: 4,
    playback: "once",
    parts: [
      part("frame", [0, 0, 0], [86, 36, 3], "#78909c"),
      part("motor", [-34, -10, 9], [12, 12, 12], "#445160"),
      part("shaft", [-25, -10, 9], [8, 5, 5], "#bd6743", "turn-x"),
      part("screw", [0, -10, 9], [62, 5, 5], "#b2aa72", "turn-x"),
      part("carriage", [-12, 0, 9], [10, 16, 8], "#5c99b4", "slide-x"),
      part("payload", [-12, 0, 17], [6, 6, 6], "#c1a745"),
    ],
    reference: {
      tracks: [track("shaft", [0, 0, 450, 900, 0])],
      couplings: [
        { driver: "shaft", follower: "screw", ratio: 1 },
        { driver: "screw", follower: "carriage", ratio: 12 / 360 },
      ],
      handoffs: [
        { time: 1, prop: "payload", carrier: "carriage" },
        { time: 3, prop: "payload", carrier: null },
      ],
    },
    checks: [
      check("Motor housing stays fixed", "motor", 2, [-30, -10, 9], [4, 0, 0]),
      check("Shaft witness turns", "shaft", 2, [-25, -10, 12], [0, 3, 0]),
      check("Screw witness turns with shaft", "screw", 2, [0, -10, 12], [0, 3, 0]),
      check("Carriage at half travel", "carriage", 2, [3, 0, 9]),
      check("Payload before pickup", "payload", 0.5, [-12, 0, 17]),
      check("Payload pose at pickup", "payload", 1, [-12, 0, 17]),
      check("Payload follows carriage", "payload", 2, [3, 0, 17]),
      check("Payload pose at release", "payload", 3, [18, 0, 17]),
      check("Payload remains at drop after carriage returns", "payload", 4, [18, 0, 17]),
      check("Carriage returns alone", "carriage", 4, [-12, 0, 9]),
    ],
  },
} satisfies Record<string, Fixture>;

export type FixtureId = keyof typeof fixtures;

function uuid(value: string) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function fixtureAssembly(id: FixtureId, answer: Answer, withChecks = false) {
  const fixture = fixtures[id];
  const root = uuid(id);
  const items = fixture.parts.map((entry) => ({
    id: uuid(id + "/item/" + entry.name), name: entry.name, number: entry.name,
    revision: "A", kind: "fabricated", color: entry.color, geometry: geometry(entry),
  }));
  const uses = fixture.parts.map(({ name, at, axis }, index) => ({
    id: uuid(id + "/use/" + name),
    itemId: items[index].id, quantity: 1, position: at,
    ...(axis && { joint: axis === "slide-x" ? { kind: "prismatic", axis: [1, 0, 0] }
      : { kind: "revolute", axis: axis === "turn-x" ? [1, 0, 0] : [0, 0, 1] } }),
  }));
  const paths = new Map(fixture.parts.map(({ name }, i) => [name, uses[i].id + "#0"]));
  function path(name: string) {
    const value = paths.get(name);
    if (!value) throw Error("Unknown fixture part " + name);
    return value;
  }
  const operation: Operation = {
    name: "Demonstrate motion", playback: fixture.playback, durationSeconds: fixture.duration,
    tracks: answer.tracks.map((entry) => ({ path: path(entry.part), keys: entry.keys })),
    handoffs: answer.handoffs.map((entry) => ({ time: entry.time, propPath: path(entry.prop),
      carrierPath: entry.carrier === null ? undefined : path(entry.carrier) })),
    ...(withChecks && { expectations: fixture.checks.map((entry) => ({
      kind: "position", label: entry.label, path: path(entry.part), time: entry.time, point: entry.point,
      expected: entry.expected, tolerance: 0.001,
    })) }),
  };
  return {
    path, assembly: AssemblySchema.parse({ rootId: root, items: [
      { id: root, name: fixture.title, number: "fixture", revision: "A", kind: "assembly", uses,
        operations: [operation],
        couplings: answer.couplings.map((entry) => ({
          driverPath: path(entry.driver), followerPath: path(entry.follower), ratio: entry.ratio,
        })) },
      ...items,
    ] }),
  };
}
