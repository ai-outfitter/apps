import { z } from "zod";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { defaultWiki, wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
import { planningEntity } from "./entities";
import type { PlanningDatabase } from "./planning";

export const useCaseTypeId = "ec742645-38b4-4b1e-a25a-77e3757b9f05";
const prose = (description: string) =>
  z.string().max(2500).describe(description);
export const useCaseBody = z.strictObject({
  actor: prose("Who is trying to accomplish the goal?"),
  goal: prose("The outcome the actor needs."),
  trigger: prose("What starts the use case, including any preconditions."),
  steps: prose("The normal sequence of actions."),
  alternatives: prose("Other paths, failures and recovery."),
  successCriteria: prose("Observable evidence that the goal was achieved."),
});
export const useCaseGraph = wikiGraph.parse({
  types: [
    {
      id: useCaseTypeId,
      category: "node",
      name: "UseCase",
      title: "Use case",
      body: "An actor's goal and the scenario that achieves it. Authored in Planning and stored in Wiki. Project association is a reference by installation and project ID, not a copy of the project.",
      jsonSchema: schemaJSON(useCaseBody),
      properties: [
        {
          name: "planning_installation_id",
          type: "string",
          required: true,
          description: "Installation owning the associated Planning project.",
        },
        {
          name: "project_id",
          type: "string",
          required: true,
          description: "Associated canonical Planning project ID.",
        },
      ],
    },
  ],
  nodes: [],
  edges: [],
});
type Host = WorkflowHost<"interactive">;
export async function setupUseCases(
  who: AppIdentity,
  host: Host,
  installationId: string,
) {
  requireEditor(who);
  const wiki = await defaultWiki(host);
  if (wiki.installationId !== installationId || !wiki.writable)
    throw new Response("Wiki is not writable", { status: 403 });
  return wikiAdapter(host, installationId).setup(useCaseGraph);
}
const belongs = (record: EntityRecord, who: AppIdentity, projectId: string) => {
  const props = record.attributes.properties as
    Record<string, unknown> | undefined;
  return (
    record.attributes.typeId === useCaseTypeId &&
    props?.planning_installation_id === who.installationId &&
    props?.project_id === projectId
  );
};
async function checkProject(
  db: PlanningDatabase,
  who: AppIdentity,
  id: string,
) {
  if (!z.uuid().safeParse(id).success)
    throw new Response("Select a valid project", { status: 400 });
  await planningEntity(db, "project").get(who, id);
}
export async function listUseCases(
  db: PlanningDatabase,
  who: AppIdentity,
  host: Host,
  projectId?: string,
) {
  if (projectId) await checkProject(db, who, projectId);
  const { installationId } = await defaultWiki(host);
  const result: EntityRecord[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await host.call("entities.list", {
      installationId,
      type: "graph-node",
      offset,
      limit: 100,
    });
    result.push(
      ...page.filter(
        (r) =>
          r.attributes.typeId === useCaseTypeId &&
          !r.attributes.archived &&
          (!projectId || belongs(r, who, projectId)),
      ),
    );
    if (page.length < 100) return result;
  }
}
export const useCaseInput = z.strictObject({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(280).default(""),
  document: useCaseBody,
  id: z.uuid().optional(),
  revision: z.number().int().positive().optional(),
  archived: z.boolean().default(false),
});
export async function saveUseCase(
  db: PlanningDatabase,
  who: AppIdentity,
  host: Host,
  input: unknown,
) {
  requireEditor(who);
  const data = useCaseInput.parse(input);
  if (!!data.id !== !!data.revision)
    throw new Response("Provide both ID and revision when editing", {
      status: 400,
    });
  await checkProject(db, who, data.projectId);
  const wiki = await defaultWiki(host);
  if (!wiki.writable) throw new Response("Wiki is not writable", { status: 403 });
  const scope = { installationId: wiki.installationId, type: "graph-node" };
  const attributes = {
    title: data.title,
    summary: data.summary,
    body: JSON.stringify(data.document),
    archived: data.archived,
  };
  if (data.id && data.revision) {
    const current = await host.call("entities.get", { ...scope, id: data.id });
    if (!belongs(current, who, data.projectId))
      throw new Response("Use case does not belong to this project", {
        status: 403,
      });
    // Patch only fields this editor owns; preserve links, properties and provenance.
    return host.call("entities.update", {
      ...scope,
      id: data.id,
      revision: data.revision,
      attributes,
      references: current.references,
    });
  }
  return host.call("entities.create", {
    ...scope,
    attributes: {
      ...attributes,
      typeId: useCaseTypeId,
      properties: {
        planning_installation_id: who.installationId,
        project_id: data.projectId,
      },
    },
    references: [],
  });
}
