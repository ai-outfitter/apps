import compiledGraph from "../../graph/.compiled/use-cases.json";
import { useCaseTypeId, useCaseBody } from "../../graph/use-cases";
import { listEntities } from "@ai-outfitter/app-sdk/database";
import { z } from "zod";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { defaultWiki, wikiAdapter } from "@ai-outfitter/app-sdk/graph-client";
import { wikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";
import { planningEntity } from "./entities";
import type { PlanningDatabase } from "./planning";

export { useCaseTypeId, useCaseBody } from "../../graph/use-cases";
export const useCaseGraph = wikiGraph.parse(compiledGraph);
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
  return listEntities(host, {
    installationId,
    type: "graph-node",
    filter: {
      typeId: useCaseTypeId,
      archived: false,
      ...(projectId ? { properties: { planning_installation_id: who.installationId, project_id: projectId } } : {}),
    },
  });
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
