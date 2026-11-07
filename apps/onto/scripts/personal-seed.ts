import { storeType } from "../src/lib/type-metadata";
import { readFile, writeFile } from "node:fs/promises";
import type { EntityRecord, EntityRef } from "@ai-outfitter/app-sdk/entities";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHostStub } from "@ai-outfitter/app-sdk/workflow-host";
import { transferFile, type TransferFile } from "./transfer";
import { graphTypes } from "../src/server/schema";
import { EDGE_IMPORT_LIMIT } from "../src/lib/entity-import";
import { core, freeSlug, slugify } from "../src/lib/graph";
import { importEntities } from "../src/server/entity-import";
import { type Database, readGraph } from "../src/server/graph";

type Seed = TransferFile;
async function readOptional(path: URL) {
  try {
    return transferFile.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function call<T>(
  host: WorkflowHostStub,
  operation: string,
  input: unknown,
): Promise<T> {
  const result = await host.call(operation, input);
  if (!result.ok) throw new Error(result.message);
  return result.value as T;
}
async function planningInstallation(host: WorkflowHostStub) {
  const types = await call<
    { type: string; writable: boolean; installationId: string }[]
  >(host, "entities.types", {});
  const ids = [
    ...new Set(
      types
        .filter((type) => type.type === "project" && type.writable)
        .map((type) => type.installationId),
    ),
  ];
  if (ids.length !== 1)
    throw new Error(
      "Local project seeding requires exactly one writable Planning installation.",
    );
  return ids[0];
}
async function verifiedReference(
  host: WorkflowHostStub,
  ref: EntityRef | undefined,
) {
  if (!ref) return;
  if (ref.type !== "project")
    throw new Error("Expected a canonical Planning project.");
  const result = await host.call("entities.get", ref);
  if (result.ok) return ref;
  if (result.status !== 404) throw new Error(result.message);
}
async function projectReferences(
  db: Database,
  who: AppIdentity,
  host: WorkflowHostStub,
  data: Seed,
  saved: Seed,
  referencePath: URL,
) {
  const graph = await readGraph(db, who);
  const refs = new Map<string, EntityRef>();
  let planningId: string | undefined;
  for (const project of data.projects) {
    if (project.typeId !== core.project)
      throw new Error("Seed projects must use the Project type.");
    const existing = graph.nodes.find((node) => node.id === project.id);
    const prior =
      existing?.source ??
      saved.projects.find((entry) => entry.id === project.id)?.source ??
      project.source;
    planningId ??= await planningInstallation(host);
    // References from a downloaded seed belong to its source environment.
    let ref = await verifiedReference(
      host,
      prior?.installationId === planningId ? prior : undefined,
    );
    if (!ref) {
      const record = await call<EntityRecord>(host, "entities.create", {
        installationId: planningId,
        type: "project",
        attributes: { name: project.title },
      });
      ref = record.ref;
      project.source = ref;
      // Persist each reference immediately so a retry does not create another project.
      await writeFile(referencePath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    }
    refs.set(project.id, ref);
  }
  return refs;
}
/** Only called by the guarded Node development entry, never packaged workers. */
export async function loadPersonalSeed(
  db: Database,
  who: AppIdentity,
  host: WorkflowHostStub,
  path = new URL("../seeds/personal.local.json", import.meta.url),
  referencePath = new URL(
    path.href.replace(/\.json$/, ".references.local.json"),
  ),
) {
  requireEditor(who);
  const data = await readOptional(path);
  if (!data) return;
  const graph = await readGraph(db, who);
  for (const type of data.types) {
    if (graph.types.some((existing) => existing.id === type.id)) continue;
    if (
      new Set(type.properties.map((property) => property.name)).size !==
      type.properties.length
    )
      throw new Error("Type property names must be unique");
    await db.insert(graphTypes).values(storeType({
      ...type,
      revision: 1,
      seedVersion: null,
      createdBy: who.userId,
      updatedBy: who.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }
  const saved =
    referencePath.href === path.href
      ? data
      : ((await readOptional(referencePath)) ?? data);
  const refs = await projectReferences(
    db,
    who,
    host,
    data,
    saved,
    referencePath,
  );
  const taken = new Set(
    [...graph.nodes, ...data.nodes, ...data.projects].map(
      (node) => node.slug ?? "",
    ),
  );
  const nodes = [
    ...data.nodes,
    ...data.projects.map(({ source: _source, ...node }) => node),
  ].map((node) => ({
    ...node,
    slug:
      node.slug ??
      graph.nodes.find((existing) => existing.id === node.id)?.slug ??
      freeSlug(slugify(node.title), taken),
  }));
  let added = 0,
    edgesAdded = 0;
  // Import nodes first so every edge endpoint exists, regardless of file size.
  for (let offset = 0; offset < nodes.length; offset += 100) {
    const result = await importEntities(
      db,
      who,
      {
        format: data.format,
        nodes: nodes.slice(offset, offset + 100),
        edges: [],
      },
      refs,
    );
    added += result.added;
  }
  for (
    let offset = 0;
    offset < data.edges.length;
    offset += EDGE_IMPORT_LIMIT
  ) {
    const batch = await importEntities(
      db,
      who,
      {
        format: data.format,
        nodes: [],
        edges: data.edges.slice(offset, offset + EDGE_IMPORT_LIMIT),
      },
      refs,
    );
    edgesAdded += batch.edgesAdded;
  }
  console.info(
    `Wiki seed context: ${added} entities and ${edgesAdded} relationships added.`,
  );
}
