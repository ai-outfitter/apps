import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { defaultWiki } from "@ai-outfitter/app-sdk/graph-client";
import {
  packageDigest,
  canonicalJSON,
  type previewWork,
} from "./work-packages";

type Preview = Awaited<ReturnType<typeof previewWork>>;
function conflict(message: string): never {
  throw new Response(message, { status: 409 });
}
async function existing(
  host: WorkflowHost<"interactive">,
  installationId: string,
  type: string,
  id: string,
) {
  try {
    return await host.call("entities.get", { installationId, type, id });
  } catch (error) {
    if (!(error instanceof Response && error.status === 404)) throw error;
    return null;
  }
}
async function createOrRead(
  host: WorkflowHost<"interactive">,
  installationId: string,
  type: string,
  attributes: EntityRecord["attributes"],
  references: EntityRecord["references"] = [],
) {
  try {
    return await host.call("entities.create", {
      installationId,
      type,
      attributes,
      references,
    });
  } catch (error) {
    if (!(error instanceof Response && error.status === 409)) throw error;
    const record = await existing(
      host,
      installationId,
      type,
      String(attributes.id),
    );
    if (!record) throw error;
    return record;
  }
}
async function edge(
  host: WorkflowHost<"interactive">,
  installationId: string,
  typeId: string,
  fromId: string,
  toId: string,
  properties: Record<string, string | number | boolean | null> = {},
) {
  const hash = await packageDigest({ installationId, typeId, fromId, toId });
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const record =
    (await existing(host, installationId, "graph-edge", id)) ??
    (await createOrRead(host, installationId, "graph-edge", {
      id,
      typeId,
      fromId,
      toId,
      properties,
    }));
  if (
    record.attributes.archived ||
    record.attributes.typeId !== typeId ||
    record.attributes.fromId !== fromId ||
    record.attributes.toId !== toId ||
    Object.entries(properties).some(
      ([key, value]) =>
        (record.attributes.properties as Record<string, unknown>)?.[key] !==
        value,
    )
  )
    conflict(
      "Work graph relationship conflicts with an authored or archived record",
    );
}

/** Recoverable projection of one canonical execution identity. Does not own
 * source requirements or provider status, and never changes their records. */
export async function projectWork(
  host: WorkflowHost<"interactive">,
  who: AppIdentity,
  snapshot: Preview,
  id: string,
  body: string,
) {
  const wiki = await defaultWiki(host);
  if (!wiki.writable)
    throw new Response("Wiki projection is not writable", { status: 403 });
  const types: EntityRecord[] = [];
  for (let offset = 0; offset < 100000; offset += 100) {
    const page = await host.call("entities.list", {
      installationId: wiki.installationId,
      type: "graph-type",
      offset,
      limit: 100,
    });
    types.push(...page.filter((record) => !record.attributes.archived));
    if (page.length < 100) break;
  }
  const typeId = (name: string) => {
    const record = types.find((record) => record.attributes.name === name);
    if (!record)
      conflict(
        `Missing Wiki ${name} definition; initialize the standard ontology`,
      );
    return record.ref.id;
  };
  const project = snapshot.manifest.sources.find(
    (source) =>
      source.attributes.typeId === typeId("Project") &&
      (source.references.some(
        (ref) =>
          canonicalJSON(ref) === canonicalJSON(snapshot.manifest.projectRef),
      ) ||
        canonicalJSON(source.attributes.source ?? null) ===
          canonicalJSON(snapshot.manifest.projectRef)),
  );
  if (!project || project.ref.installationId !== wiki.installationId)
    conflict("Frozen package has no canonical Wiki project anchor");
  const source = {
    installationId: who.installationId,
    type: "work-submission",
    id,
  };
  let node = await existing(host, wiki.installationId, "graph-node", id);
  if (!node)
    node = await createOrRead(
      host,
      wiki.installationId,
      "graph-node",
      {
        id,
        typeId: typeId("Issue"),
        title: `Work package: ${snapshot.title}`.slice(0, 200),
        body,
      },
      [source],
    );
  if (
    node.attributes.archived ||
    node.attributes.typeId !== typeId("Issue") ||
    canonicalJSON(node.references) !== canonicalJSON([source])
  )
    conflict("Work graph node conflicts with an authored or archived record");
  if (node.attributes.body !== body)
    await host.call("entities.update", {
      installationId: wiki.installationId,
      type: "graph-node",
      id,
      revision: node.revision,
      attributes: { body },
      references: [source],
    });
  await edge(
    host,
    wiki.installationId,
    typeId("has_issue"),
    project.ref.id,
    id,
  );
  for (const requirementId of snapshot.manifest.selection.requirementIds)
    await edge(
      host,
      wiki.installationId,
      typeId("targets_requirement"),
      id,
      requirementId,
    );
  return { installationId: wiki.installationId, type: "graph-node", id };
}
