// Workshop's design agent: one design request, or a follow-up to the current
// model, becomes a CAD plan saved as the project's next revision. The model
// call goes through the workflow host's `inference.generate` on a run of the
// workshop-design workflow, so the platform chooses the provider and meters
// the call to that run; Workshop owns the prompt, the answer schema and the
// project it saves.
import { sha256Hex } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { z } from "zod";
import designPrompt from "../../agent/design-agent.md?raw";
import { planBounds } from "../model/cad-plan";
import { answerSchema, type designInput, designData, designedProject, ITERATION_LIMIT, parseAnswer } from "../model/design-answer";
import type { WorkshopContext } from "./graphql";
import { createWorkshopProject, getWorkshopProject, listWorkshopProjects, PROJECT_LIMIT, updateWorkshopProject } from "./projects";

export const designWorkflow = "workshop-design";
export const designStep = "design";
export const promptPath = "apps/workshop/agent/design-agent.md";

/** One design turn as the member: checks, one model answer on a workshop-design run, the saved project. */
export async function designTurn(context: WorkshopContext, input: z.output<typeof designInput>, host: WorkflowHost<"interactive"> = context.host()) {
  const db = context.db();
  const current = input.projectId ? await getWorkshopProject(db, input.projectId) : undefined;
  if (current && current.revision !== input.revision) throw new Response("Project changed in another session. Reload and retry.", { status: 409 });
  if (current && current.iterations.length >= ITERATION_LIMIT) throw new Response(`This model has ${ITERATION_LIMIT} iterations. Start another project.`, { status: 409 });
  if (!current && (await listWorkshopProjects(db)).length >= PROJECT_LIMIT) throw new Response(`Workshop holds up to ${PROJECT_LIMIT} projects.`, { status: 409 });
  const prompt = { path: promptPath, digest: await sha256Hex(designPrompt) };
  const run = await host.call("workflow.start", {
    workflow: designWorkflow, id: crypto.randomUUID(),
    inputs: { [`${designStep}.inputs.message`]: input.message, [`${designStep}.inputs.projectId`]: current?.id ?? null },
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
  await host.call("workflow.collect", {
    runId: run.id, slot: `${designStep}.outputs.design`,
    value: { projectId: project.id, revision: project.revision, name: project.name, features: generated.plan.features.length, size: planBounds(generated.plan).size, prompt },
  });
  return { project, rationale: generated.rationale, runId: run.id };
}
