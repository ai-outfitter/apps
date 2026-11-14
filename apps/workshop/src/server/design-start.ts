// Starting and following design work without the model in the request: the
// StartWorkshopDesign mutation and WorkshopDesignRun query (graphql.ts) and the
// checks a design turn shares with them. The turn itself, with the design
// agent's prompt, is design.ts.
import { z } from "zod";
import { type designInput, ITERATION_LIMIT } from "../model/design-answer";
import type { WorkshopContext } from "./graphql";
import { getWorkshopProject, listWorkshopProjects, PROJECT_LIMIT } from "./projects";

export const designWorkflow = "workshop-design";
export const designStep = "design";

/** What `task.start` and `workflow.start` hand the run: the request as plain JSON. */
export const taskInputs = (input: z.output<typeof designInput>) =>
  ({ message: input.message, ...(input.projectId ? { projectId: input.projectId, revision: input.revision as number } : {}) });

/** The checks before any run starts: the revision the caller saw, the iteration limit and the project cap. Answers the current project of a follow-up. */
export async function admitDesign(context: WorkshopContext, input: z.output<typeof designInput>) {
  const db = context.db();
  const current = input.projectId ? await getWorkshopProject(db, input.projectId) : undefined;
  if (current && current.revision !== input.revision) throw new Response("Project changed in another session. Reload and retry.", { status: 409 });
  if (current && current.iterations.length >= ITERATION_LIMIT) throw new Response(`This model has ${ITERATION_LIMIT} iterations. Start another project.`, { status: 409 });
  if (!current && (await listWorkshopProjects(db)).length >= PROJECT_LIMIT) throw new Response(`Workshop holds up to ${PROJECT_LIMIT} projects.`, { status: 409 });
  return current;
}

/** StartWorkshopDesign's input: a design request, and optionally the run id the caller chose so a retry starts nothing twice. */
export const startDesignInput = z
  .strictObject({
    id: z.uuid().optional().describe("Choose once and reuse for an identical retry; a new one is made when left out."),
    message: z.string().trim().min(1).max(500).describe("The design request, or the follow-up to the current model."),
    projectId: z.uuid().optional().describe("The project a follow-up changes; leave out to start a new project."),
    revision: z.number().int().nonnegative().optional().describe("That project's revision as the caller saw it; required with projectId."),
  })
  .refine((value) => Boolean(value.projectId) === (value.revision !== undefined), "Project ID and revision must be supplied together");
export const designRunInput = z.strictObject({ id: z.uuid() });

/** A workshop-design run as a caller follows it. */
function designRunView(run: { id: string; status: string; createdAt: number; updatedAt: number }, design: unknown = null) {
  return { id: run.id, status: run.status, design, startedAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() };
}

/** One workshop-design run of this installation: its status and, once designed, the project revision it saved. */
export async function designRun(context: WorkshopContext, { id }: z.output<typeof designRunInput>) {
  const read = await context.host().call("workflow.read", { id });
  if (!read || read.run.workflowId !== designWorkflow) throw new Response("Design run not found", { status: 404 });
  const output = read.outputs[`${designStep}.outputs.design`];
  return designRunView(read.run, output?.complete ? output.value : null);
}

/** Start design work without waiting for the model: the request is checked as a design turn checks it, then
 * the platform's durable task dispatch runs the turn (runDesignTask) and the caller follows the run. */
export async function startDesign(context: WorkshopContext, { id, ...input }: z.output<typeof startDesignInput>) {
  const host = context.host();
  // A retry with the same id answers the run it already started, even after that run moved the project on.
  const started = id ? await host.call("workflow.read", { id }) : null;
  if (started && started.run.workflowId !== designWorkflow) throw new Response("That run id belongs to other work.", { status: 409 });
  if (!started) await admitDesign(context, input);
  const run = await host.call("task.start", { task: designWorkflow, id: id ?? crypto.randomUUID(), inputs: taskInputs(input) });
  return { ...(await designRun(context, { id: run.id })), created: run.created };
}
