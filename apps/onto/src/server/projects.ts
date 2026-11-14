import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import { type AppIdentity, requireEditor } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { eq } from "drizzle-orm";
import { appRecordKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { z } from "zod";
import { core, nodeInput } from "../lib/graph";
import { type Database, nodeView, saveNode } from "./graph";
import { graphNodes } from "./schema";

type Host = WorkflowHost<"interactive">;
export async function projectChoices(host: Host) {
  const publishers = (await host.call("entities.types", {})).filter(
    (t) => t.type === "project" && t.writable,
  );
  const installations = [...new Set(publishers.map((t) => t.installationId))];
  const projects: EntityRecord[] = [];
  for (const installationId of installations) {
    for (let offset = 0; ; offset += 100) {
      const page = await host.call("entities.list", {
        installationId,
        type: "project",
        offset,
        limit: 100,
      });
      projects.push(...page);
      if (page.length < 100) break;
    }
  }
  return { installations, projects };
}
export const projectRequest = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("create"),
    installationId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    body: z.string().max(20000).default(""),
  }),
  z.strictObject({
    mode: z.literal("link"),
    reference: entityRef,
    body: z.string().max(20000).default(""),
  }),
]);
export async function createProjectContext(
  db: Database,
  who: AppIdentity,
  host: Host,
  input: unknown,
) {
  requireEditor(who);
  const data = projectRequest.parse(input);
  if (data.mode === "link" && data.reference.type !== "project")
    throw new Response("Select a Planning project", { status: 400 });
  const project =
    data.mode === "create"
      ? await host.call("entities.create", {
          installationId: data.installationId,
          type: "project",
          attributes: { name: data.name },
        })
      : await host.call("entities.get", data.reference);
  const source = project.ref;
  const existing = await db
    .select()
    .from(graphNodes)
    .where(eq(graphNodes.externalKey, appRecordKey(source)));
  if (existing[0]) return { project, node: nodeView(existing[0]) };
  try {
    const node = await saveNode(
      db,
      who,
      { verifiedReferences: true },
      nodeInput.parse({
        typeId: core.project,
        title: project.title,
        body: data.body,
      }),
      [source],
    );
    return { project, node };
  } catch {
    // The two apps cannot share a transaction. Preserve the canonical reference
    // so a retry links it instead of creating another Planning project.
    const [linked] = await db
      .select()
      .from(graphNodes)
      .where(eq(graphNodes.externalKey, appRecordKey(source)));
    return {
      project,
      node: linked ? nodeView(linked) : null,
      error: linked
        ? undefined
        : "Planning project saved. Retry to finish its documentation.",
    };
  }
}
