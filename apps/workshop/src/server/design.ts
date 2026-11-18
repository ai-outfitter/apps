// Workshop's design agent: one design request, or a follow-up to the current
// model, becomes a CAD plan saved as the project's next revision. The model
// call goes through the workflow host's `inference.generate` on a run of the
// workshop-design workflow, so the platform chooses the provider and meters
// the call to that run; Workshop owns the prompt, the answer schema and the
// project it saves. A turn starts from the project page (designTurn) or from
// the StartWorkshopDesign mutation and the platform's StartTasks (design-start.ts,
// then runDesignTask when the platform dispatches the task).
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import { taskInvocation, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { z } from "zod";
import designPrompt from "../../agent/design-agent.md?raw";
import { planBounds } from "../model/cad-plan";
import { answerSchema, designInput, designData, designedProject, parseAnswer } from "../model/design-answer";
import type { WorkshopContext } from "./graphql";
import { admitDesign, designStep, designWorkflow, taskInputs } from "./design-start";
import { createWorkshopProject, updateWorkshopProject } from "./projects";

export { designStep, designWorkflow };

export const promptPath = "apps/workshop/agent/design-agent.md";

/** One design turn as the member: checks, one model answer on a workshop-design run, the saved project.
 * The page starts its own run; a started task (`runId`) designs on the run the platform already claimed. */
export async function designTurn(context: WorkshopContext, input: z.output<typeof designInput>, host: WorkflowHost<"interactive"> = context.host(), runId?: string) {
  const db = context.db();
  const current = await admitDesign(context, input);
  const prompt = { path: promptPath, digest: await sha256Hex(designPrompt) };
  const run = runId ? { id: runId } : await host.call("workflow.start", {
    workflow: designWorkflow, id: crypto.randomUUID(), inputs: { [`${designStep}.inputs.request`]: taskInputs(input) },
  });
  const { output } = await host.call("inference.generate", {
    runId: run.id, step: designStep, instructions: designPrompt, schema: answerSchema as unknown as Record<string, never>,
    // Plain JSON: the request, the current plan and recent messages.
    data: JSON.parse(JSON.stringify(designData(input.message, current))),
  });
  const generated = parseAnswer(output);
  const next = designedProject(input.message, generated, current);
  // The save checks the revision and the project cap again; losing either race is a 409.
  const project = current
    ? await updateWorkshopProject(db, context.identity, { ...next, revision: current.revision }, current.id)
    : await createWorkshopProject(db, context.identity, next);
  const design = { projectId: project.id, revision: project.revision, name: project.name, features: generated.plan.features.length, size: planBounds(generated.plan).size, prompt };
  await host.call("workflow.collect", { runId: run.id, slot: `${designStep}.outputs.design`, value: design });
  return { project, rationale: generated.rationale, runId: run.id, design };
}

/** The platform's dispatch of a started task (the workflow host's interactive phase): the same design turn, on its run. */
export async function runDesignTask(context: WorkshopContext, raw: unknown, host: WorkflowHost<"interactive">) {
  const task = taskInvocation.parse(raw);
  if (task.task !== designWorkflow) throw new Response("Unknown task", { status: 404 });
  const input = designInput.safeParse(task.inputs);
  if (!input.success) throw new Response("The design request is not valid.", { status: 400 });
  return (await designTurn(context, input.data, host, task.runId)).design;
}
