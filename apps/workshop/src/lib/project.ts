import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { CadPlanSchema, planBounds } from "../model/cad-plan";
import { AssemblySchema } from "./assembly";
import { sensorNodeAssembly } from "./sensor-node";
export const ParamsSchema = z
  .object({
    design: z.enum(["cube", "tray", "button", "sensor", "custom"]),
    width: z.number().min(1).max(300),
    depth: z.number().min(1).max(300),
    height: z.number().min(1).max(300),
    wall: z.number().min(1.2).max(6),
  })
  .strict()
  .refine(
    (p) =>
      p.design === "custom" ||
      (p.width >= 25 &&
        p.depth >= 20 &&
        p.depth <= 160 &&
        p.height >= 8 &&
        p.height <= 80 &&
        p.wall * 2 < Math.min(p.width, p.depth, p.height)),
    "Walls must leave room inside the part",
  )
  .refine(
    (p) =>
      p.design !== "cube" ||
      (p.width === p.depth && p.depth === p.height && p.width <= 80),
    "A cube needs equal sides from 25 to 80 mm",
  );
const text = z.string().max(5000);
const url = z
  .string()
  .max(2000)
  .refine((s) => !s || /^https?:\/\//i.test(s), "Use an http or https URL");
// Concept mockups: what we think the product will look like. The image bytes
// live in the app's file storage (space `concepts`); the project keeps only
// the reference, so the document stays small.
export const CONCEPT_LIMIT = 40;
export const ConceptSchema = z
  .object({
    id: z.uuid(),
    key: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    prompt: z.string().trim().max(4000),
    /** The image model, or "upload" for an image made elsewhere. */
    model: z.string().trim().min(1).max(80),
    caption: z.string().trim().max(300),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Concept = z.infer<typeof ConceptSchema>;
const ConceptsSchema = z.array(ConceptSchema).max(CONCEPT_LIMIT).default([]);
/** Where a project stands on the way from an idea to a manufactured product. */
export const PHASES = [
  { id: "concept", label: "Concept" },
  { id: "prototyping", label: "Prototyping" },
  { id: "validation", label: "Validation" },
  { id: "pilot", label: "Pilot run" },
  { id: "manufacturing", label: "Manufacturing" },
] as const;
export type Phase = (typeof PHASES)[number]["id"];
const PHASE_IDS = PHASES.map((p) => p.id) as [Phase, ...Phase[]];

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["mechanical", "electronics"]),
    phase: z.enum(PHASE_IDS).default("concept"),
    brief: text,
    owner: z.string().max(100),
    requirements: text,
    params: ParamsSchema,
    // The Wiki ProductRevision this project builds: its record id, the Wiki
    // installation when known, and a cached title and link for display.
    productRevision: z
      .object({
        id: z.uuid(),
        wikiInstallationId: z.string().trim().min(1).max(100).optional(),
        title: z.string().trim().max(200),
        url,
      })
      .strict()
      .optional(),
    cadPlan: CadPlanSchema.optional(),
    measurementNotes: text,
    circuitNotes: text,
    research: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(150),
            kind: z.enum(["COTS", "Open design", "Prior art"]),
            url,
            notes: text,
            decision: z.enum(["Investigate", "Use", "Adapt", "Reject"]),
          })
          .strict(),
      )
      .max(100),
    parts: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(150),
            quantity: z.number().int().min(1).max(10000),
            unitCost: z.number().min(0).max(100000),
            source: url,
            notes: text,
          })
          .strict(),
      )
      .max(200),
    evidence: z
      .array(
        z
          .object({
            id: z.uuid(),
            stage: z.enum([
              "Measurement",
              "Fit test",
              "Breadboard",
              "PCB bring-up",
            ]),
            outcome: z.enum(["Pass", "Fail", "Observation"]),
            note: z.string().trim().min(1).max(2000),
            operator: z.string().trim().min(1).max(100),
            at: z.iso.datetime(),
            designKey: z.string().length(64),
            baselineKey: z.string().length(64),
            serialLog: z.string().max(4000),
          })
          .strict(),
      )
      .max(
        30,
        "Keep up to 30 observations. Export and remove an old observation before adding another.",
      ),
    iterations: z
      .array(
        z
          .object({
            id: z.uuid(),
            prompt: z.string().trim().min(1).max(500),
            rationale: z.string().trim().min(1).max(1000),
            size: z.number().min(25).max(80).optional(),
            dimensions: z
              .object({
                width: z.number().min(1).max(200),
                depth: z.number().min(1).max(200),
                height: z.number().min(1).max(200),
              })
              .strict()
              .optional(),
            at: z.iso.datetime(),
            revision: z.number().int().positive(),
          })
          .strict()
          .refine((item) => item.size !== undefined || item.dimensions),
      )
      .max(30)
      .default([]),
    concepts: ConceptsSchema,
    /** Items and BOM lines: the product structure Workshop builds and stocks. */
    assembly: AssemblySchema.default({ items: [] }),
  })
  .strict()
  .refine((p) => {
    if (p.params.design !== "custom") return !p.cadPlan;
    if (!p.cadPlan) return false;
    const { size } = planBounds(p.cadPlan);
    return (
      p.params.width === size[0] &&
      p.params.depth === size[1] &&
      p.params.height === size[2]
    );
  }, "CAD plan and dimensions must agree")
  .refine(
    (p) => new TextEncoder().encode(JSON.stringify(p)).length <= 1_500_000,
    "Project exceeds the draft storage limit; shorten notes or remove unused parts/candidates.",
  );
export type Project = z.infer<typeof ProjectSchema>;
export type Params = z.infer<typeof ParamsSchema>;
export type ProductRevision = NonNullable<Project["productRevision"]>;
const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A pasted Wiki record link or bare record id: the last UUID in it is the record. */
export function productRevisionFrom(
  link: string,
  title: string,
  wikiInstallationId = "",
): ProductRevision | undefined {
  const text = link.trim();
  const id = text.match(uuids)?.at(-1)?.toLowerCase();
  if (!id) return undefined;
  return {
    id,
    ...(wikiInstallationId.trim()
      ? { wikiInstallationId: wikiInstallationId.trim() }
      : {}),
    title: title.trim().slice(0, 200),
    url: /^https?:\/\//i.test(text) ? text.slice(0, 2000) : "",
  };
}
export function designKey(p: Pick<Project, "params" | "kind" | "cadPlan">) {
  const inputs: unknown[] = [
    p.kind,
    p.params.design,
    p.params.width,
    p.params.depth,
    p.params.height,
    p.params.wall,
  ];
  if (p.cadPlan) inputs.push(p.cadPlan);
  return bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(inputs))),
  );
}
export function electricalKey(p: Project) {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          p.circuitNotes,
          p.parts.map((r) => [r.id, r.name, r.quantity, r.notes]),
        ]),
      ),
    ),
  );
}
export function pcbReady(p: Project) {
  const latest = p.evidence.filter((e) => e.stage === "Breadboard").at(-1);
  return (
    p.kind === "electronics" &&
    p.circuitNotes.trim().length > 0 &&
    latest?.outcome === "Pass" &&
    latest.baselineKey === electricalKey(p)
  );
}
export function fitReady(p: Project) {
  const latest = p.evidence
    .filter((e) => e.stage === "Fit test" && e.designKey === designKey(p))
    .at(-1);
  return latest?.outcome === "Pass";
}
export function makeProject(example: string): Project {
  if (!Object.hasOwn(EXAMPLES, example)) throw new Error("Unknown example");
  const now = new Date().toISOString();
  const base: Project = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    name: EXAMPLES[example as keyof typeof EXAMPLES].name,
    kind: "mechanical",
    phase: "concept",
    brief: "Keep charging cables within reach at the edge of a desk.",
    owner: "",
    requirements:
      "Fit the measured desk space. Keep cables accessible. Check the print against the actual cables before use.",
    params: { design: "tray", width: 80, depth: 35, height: 18, wall: 2.4 },
    measurementNotes:
      "Starter dimensions are assumptions. Measure your cables and available desk space.",
    circuitNotes: "",
    research: [],
    parts: [],
    evidence: [],
    iterations: [],
    concepts: [],
    assembly: { items: [] },
  };
  if (example === "cube")
    Object.assign(base, {
      name: "Solid cube",
      brief:
        "Start with a simple solid cube and refine its dimensions.",
      requirements:
        "Keep all sides equal. Use millimetres. Confirm the rendered dimensions before fabrication.",
      params: { design: "cube", width: 35, depth: 35, height: 35, wall: 2.4 },
      measurementNotes:
        "The starting dimensions are generated design intent, not a physical measurement.",
    });
  if (example === "button")
    Object.assign(base, {
      kind: "electronics",
      brief: "Press a desk button to toggle an LED status.",
      requirements:
        "Use USB power for the first breadboard. Verify repeated presses, debounce, and restart behavior before considering a PCB.",
      params: { design: "button", width: 70, depth: 50, height: 28, wall: 2.4 },
      measurementNotes:
        "Enclosure concept only. Measure the selected board, connectors, button and wiring clearance.",
    });
  if (example === "sensor")
    Object.assign(base, {
      kind: "electronics",
      brief: "Report a workspace sensor reading to a local server.",
      requirements:
        "Compare readings with a reference. Record reconnect and power-cycle behavior. Select exact COTS modules before enclosure fit.",
      params: { design: "sensor", width: 85, depth: 55, height: 30, wall: 2.4 },
      measurementNotes:
        "Measure the sensor, ESP32 board, connectors and airflow path. Starter dimensions and vent spacing are unverified.",
    });
  if (example === "node")
    Object.assign(base, {
      kind: "electronics",
      name: "SNY-1 soil sensor node",
      brief: "Measure soil moisture, CO2 and light outdoors on solar power, and report to a local server.",
      requirements:
        "Run on a 6 V 1 W panel and a LiFePO4 cell. Read CO2 in single-shot mode every 5 to 10 minutes. Track every ESP32-S3 by MAC address and record the firmware flashed.",
      params: { design: "sensor", width: 140, depth: 95, height: 35, wall: 2.5 },
      measurementNotes:
        "COTS parts are dimensioned envelopes. Check each against the manufacturer's drawing before printing the enclosure.",
      assembly: sensorNodeAssembly(),
    });
  return ProjectSchema.parse(base);
}

export const EXAMPLES = {
  cube: {
    icon: "◇",
    name: "Solid cube",
    description: "Start with a solid cube and refine its size.",
    label: "CAD · SIMPLEST START",
  },
  holder: {
    icon: "⌑",
    name: "Cable keeper",
    description: "A simple tray to test measurement, CAD, and physical fit.",
    label: "MECHANICAL · START HERE",
  },
  button: {
    icon: "◉",
    name: "Desk status button",
    description: "A USB breadboard experiment with a button and LED.",
    label: "ELECTRONICS · NEXT STEP",
  },
  node: {
    icon: "▦",
    name: "SNY-1 soil sensor node",
    description:
      "An assembly with an electronics sub-assembly, an ESP32-S3, firmware and inventory.",
    label: "ASSEMBLY · ESP32-S3",
  },
  sensor: {
    icon: "⌁",
    name: "Workspace sensor",
    description:
      "Connect a sensor to a local service and observe its behavior.",
    label: "CONNECTED DEVICE · EXPLORE",
  },
};
