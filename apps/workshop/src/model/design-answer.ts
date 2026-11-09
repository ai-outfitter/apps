// The design agent's contract with the model: the request it sends as data,
// the answer it asks for and how that answer becomes the project's next
// revision. Pure, so tests and the box exercise it without a model.
import { z } from "zod";
import { makeProject, type Project, ProjectSchema } from "../lib/project";
import { CadPlanSchema, planBounds, presetPlan } from "./cad-plan";

/** A project keeps this many design turns; start another project after that. */
export const ITERATION_LIMIT = 30;

export const designInput = z
  .object({
    message: z.string().trim().min(1).max(500),
    projectId: z.uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.projectId) === (value.revision !== undefined), "Project ID and revision must be supplied together");

const triple = (minimum: number, maximum: number) => ({ type: "array", items: { type: "number", minimum, maximum }, minItems: 3, maxItems: 3 });
const mode = { type: "string", enum: ["add", "cut"] };
/** The answer the model gives, as JSON Schema. Tuples are plain three-number
 * arrays here, which more providers accept; the answer is parsed again with
 * the CAD plan contract (`CadPlanSchema`) before anything is saved. */
export const answerSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
    plan: {
      type: "object",
      properties: {
        version: { type: "number", const: 1 },
        units: { type: "string", const: "mm" },
        features: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            anyOf: [
              {
                type: "object",
                properties: { kind: { type: "string", const: "box" }, mode, origin: triple(-300, 300), size: triple(1, 300) },
                required: ["kind", "mode", "origin", "size"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "cylinder" }, mode, base: triple(-300, 300),
                  radius: { type: "number", minimum: 0.1, maximum: 300 }, height: { type: "number", minimum: 1, maximum: 300 },
                  axis: { type: "string", enum: ["x", "y", "z"] },
                },
                required: ["kind", "mode", "base", "radius", "height", "axis"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["version", "units", "features"],
      additionalProperties: false,
    },
  },
  required: ["name", "rationale", "plan"],
  additionalProperties: false,
} as const;

const GeneratedDesign = z.object({ name: z.string().trim().min(1).max(80), rationale: z.string().trim().min(1).max(1000), plan: CadPlanSchema }).strict();
export type GeneratedDesign = z.infer<typeof GeneratedDesign>;

/** The model's answer under the CAD plan contract, or 502: the model, not the member, got it wrong. */
export function parseAnswer(output: unknown): GeneratedDesign {
  const parsed = GeneratedDesign.safeParse(output);
  if (!parsed.success) throw new Response("The design model returned an invalid CAD plan. Retry the request.", { status: 502 });
  return parsed.data;
}

/** The step's data: the request, or the current model with its recent design messages and the follow-up. */
export function designData(message: string, current?: Project) {
  if (!current) return { request: message };
  return {
    currentModel: {
      name: current.name,
      brief: current.brief.slice(0, 1000),
      requirements: current.requirements.slice(0, 1000),
      plan: current.cadPlan ?? presetPlan(current.params),
    },
    priorMessages: current.iterations.slice(-8).map((item) => ({ message: item.prompt, result: item.rationale, dimensions: item.dimensions ?? item.size })),
    followUp: message,
  };
}

/** The project after one design turn: the generated plan as its next revision. */
export function designedProject(message: string, generated: GeneratedDesign, current: Project | undefined, now = new Date().toISOString()): Project {
  const revision = (current?.revision ?? 0) + 1;
  const [width, depth, height] = planBounds(generated.plan).size;
  const parsed = ProjectSchema.safeParse({
    ...(current ?? { ...makeProject("cube"), createdAt: now }),
    name: current ? current.name : generated.name,
    brief: current?.brief ?? message,
    requirements: current?.requirements ?? "Confirm dimensions and fit against measurements before fabrication.",
    params: { design: "custom", width, depth, height, wall: 2.4 },
    cadPlan: generated.plan,
    measurementNotes: current?.measurementNotes ?? "Generated dimensions are design intent. Verify them before fabrication.",
    revision,
    updatedAt: now,
    iterations: [
      ...(current?.iterations ?? []),
      { id: crypto.randomUUID(), prompt: message, rationale: generated.rationale, dimensions: { width, depth, height }, at: now, revision },
    ],
  });
  if (!parsed.success) throw new Response("Generated design exceeds this project's limits.", { status: 409 });
  return parsed.data;
}
