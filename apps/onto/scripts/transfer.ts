import { z } from "zod";
import type { EntityRecord, EntityRef } from "@ai-outfitter/app-sdk/entities";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import {
  core,
  edgeInput,
  nodeInput,
  typeInput,
  validateProperties,
} from "../src/lib/graph";

// The transfer file contains public graph fields, never connector identity.
export const transferFile = z
  .strictObject({
    format: z.literal("outfitter-graph-entities-v1"),
    types: z
      .array(typeInput.extend({ id: z.uuid() }))
      .max(1000)
      .default([]),
    nodes: z.array(nodeInput.extend({ id: z.uuid() })).max(10000),
    projects: z
      .array(nodeInput.extend({ id: z.uuid(), source: entityRef.optional() }))
      .max(10000)
      .default([]),
    edges: z
      .array(edgeInput.extend({ id: z.uuid() }))
      .max(50000)
      .default([]),
  })
  .superRefine((file, ctx) => {
    for (const rows of [
      file.types,
      [...file.nodes, ...file.projects],
      file.edges,
    ]) {
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        ctx.addIssue({ code: "custom", message: "Duplicate record ID" });
    }
    if (
      file.projects.some((row) => row.typeId !== core.project)
    )
      ctx.addIssue({
        code: "custom",
        message: "Planning project entries must have the Project type",
      });
  });
export function mergeFiles(
  left: TransferFile,
  right: TransferFile,
): TransferFile {
  const merged = { ...left };
  for (const key of ["types", "nodes", "projects", "edges"] as const) {
    const records = new Map<string, { id: string }>();
    for (const row of [...left[key], ...right[key]]) {
      const prior = records.get(row.id);
      if (prior && !equal(prior, row))
        throw new Error(`Conflicting input ${key}/${row.id}`);
      records.set(row.id, row);
    }
    Object.assign(merged, { [key]: [...records.values()] });
  }
  return transferFile.parse(merged);
}
export type TransferFile = z.infer<typeof transferFile>;
export type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
type Entry = {
  ref: EntityRef;
  base: Record<string, unknown>;
  references: EntityRef[];
};
export type Journal = {
  endpoint: string;
  wiki: string;
  planning?: string;
  entries: Record<string, Entry>;
  pending?: {
    key: string;
    type: string;
    installationId: string;
    attributes: Record<string, unknown>;
    references?: EntityRef[];
  };
};
export const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equal(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
};
const schema = (type: string) =>
  type === "graph-type"
    ? typeInput.omit({ id: true })
    : type === "graph-edge"
      ? edgeInput.omit({ id: true })
      : nodeInput.omit({ id: true });
export function fields(record: EntityRecord) {
  const input = schema(record.ref.type);
  return input.parse(
    Object.fromEntries(
      Object.keys(input.shape)
        .filter((key) => key in record.attributes)
        .map((key) => [key, record.attributes[key]]),
    ),
  );
}
export async function listAll(
  call: Call,
  installationId: string,
  type: string,
): Promise<EntityRecord[]> {
  const rows: EntityRecord[] = [];
  for (let offset = 0; offset <= 100000; offset += 100) {
    const page = (await call("list_entities", {
      installationId,
      type,
      offset,
      limit: 100,
    })) as EntityRecord[];
    rows.push(...page);
    if (page.length < 100) return rows;
  }
  throw new Error("Export exceeds the entity pagination limit");
}
/** A definite tool refusal cannot have created a record; transport failures remain uncertain. */
export class ToolRefusal extends Error {}
export function decodeToolResult(result: unknown) {
  const parsed = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .parse(result);
  const text = parsed.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (parsed.isError)
    throw new ToolRefusal(text || "Outfitter refused the operation");
  return JSON.parse(text);
}

export async function discover(
  call: Call,
  wiki: string,
  planning?: string,
  writing = false,
) {
  const types = (await call("list_entity_types", {})) as {
    installationId: string;
    type: string;
    writable: boolean;
  }[];
  const required = ["graph-type", "graph-node", "graph-edge"].map((type) => [
    wiki,
    type,
  ]);
  if (planning && writing) required.push([planning, "project"]);
  for (const [installationId, type] of required)
    if (
      !types.some(
        (row) =>
          row.installationId === installationId &&
          row.type === type &&
          (!writing || row.writable),
      )
    )
      throw new Error(
        `No ${writing ? "writable " : ""}personal ${type} provider at ${installationId}. Check your entities consent and installation.`,
      );
}
export async function exportFile(call: Call, journal: Journal) {
  if (journal.pending)
    throw new Error(
      `Resolve uncertain create ${journal.pending.key} before exporting`,
    );
  const [types, nodes, edges] = await Promise.all(
    ["graph-type", "graph-node", "graph-edge"].map((type) =>
      listAll(call, journal.wiki, type),
    ),
  );
  const reverse = new Map(
    Object.entries(journal.entries).map(([key, entry]) => [
      `${entry.ref.type}/${entry.ref.id}`,
      key.slice(key.indexOf("/") + 1),
    ]),
  );
  const local = (type: string, id: string) =>
    reverse.get(`${type}/${id}`) ?? id;
  const remember = (row: EntityRecord) => {
    const id = local(row.ref.type, row.ref.id);
    journal.entries[`${row.ref.type}/${id}`] = {
      ref: row.ref,
      base: fields(row),
      references: row.references,
    };
    return id;
  };
  const file: TransferFile = {
    format: "outfitter-graph-entities-v1",
    types: [],
    nodes: [],
    projects: [],
    edges: [],
  };
  file.types = types.map((row) => ({
    ...typeInput.parse(fields(row)),
    id: remember(row),
  }));
  for (const row of nodes) {
    const data = nodeInput.parse(fields(row));
    data.typeId = local("graph-type", data.typeId);
    const node = { ...data, id: remember(row) };
    if (node.typeId === core.project && row.references.length) {
      if (row.references.length !== 1 || row.references[0].type !== "project")
        throw new Error(`Project ${node.id} has no canonical reference`);
      file.projects.push({ ...node, source: row.references[0] });
      journal.entries[`project/${node.id}`] = {
        ref: row.references[0],
        base: {},
        references: [],
      };
    } else {
      if (row.references.length)
        throw new Error(
          `Node ${node.id} has an unsupported canonical reference; refusing a lossy export`,
        );
      file.nodes.push(node);
    }
  }
  file.edges = edges.map((row) => {
    const data = edgeInput.parse(fields(row));
    return {
      ...data,
      id: remember(row),
      typeId: local("graph-type", data.typeId),
      fromId: local("graph-node", data.fromId),
      toId: local("graph-node", data.toId),
    };
  });
  return transferFile.parse(file);
}

/** Merge independent field edits; overlapping local/remote edits require an export and reconciliation. */
export function changes(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  base?: Record<string, unknown>,
) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(local)) {
    if (equal(value, remote[key]) || (base && equal(value, base[key])))
      continue;
    if (!base || !equal(remote[key], base[key]))
      throw new Error(
        `Conflicting ${key}; export and reconcile before uploading`,
      );
    patch[key] = value;
  }
  return patch;
}

function unchangedRecord(
  kind: string,
  row: { id: string },
  cache: Map<string, EntityRecord>,
  mapped: (type: string, id: string) => string,
) {
  const remote = cache.get(`${kind}/${mapped(kind, row.id)}`);
  if (!remote) return false;
  const input = schema(kind);
  const source = row as unknown as Record<string, unknown>;
  const attributes = input.parse(
    Object.fromEntries(
      Object.keys(input.shape)
        .filter((key) => key in source)
        .map((key) => [key, source[key]]),
    ),
  ) as Record<string, unknown>;
  attributes.typeId = mapped("graph-type", String(attributes.typeId));
  if (kind === "graph-edge") {
    attributes.fromId = mapped("graph-node", String(attributes.fromId));
    attributes.toId = mapped("graph-node", String(attributes.toId));
  }
  return equal(fields(remote), attributes);
}
export function configureTarget(
  journal: Journal,
  endpoint: string,
  wiki: string,
  planning?: string,
) {
  if (
    journal.endpoint !== endpoint ||
    journal.wiki !== wiki ||
    (planning && journal.planning && journal.planning !== planning)
  )
    throw new Error(
      "Transfer state belongs to another target. Keep the existing receipt for its installation.",
    );
  if (!journal.planning && planning) journal.planning = planning;
}
function checkRecordTypes(
  file: TransferFile,
  types: Map<string, z.infer<typeof typeInput>>,
  cache: Map<string, EntityRecord>,
  mapped: (type: string, id: string) => string,
) {
  for (const [category, rows] of [
    ["node", [...file.nodes, ...file.projects]],
    ["edge", file.edges],
  ] as const) {
    for (const row of rows) {
      if (
        unchangedRecord(
          category === "node" ? "graph-node" : "graph-edge",
          row,
          cache,
          mapped,
        )
      )
        continue;
      const type = types.get(mapped("graph-type", row.typeId));
      if (!type || type.category !== category || type.archived)
        throw new Error(`Invalid active ${category} type for ${row.id}`);
      validateProperties(
        {
          ...type,
          id: row.typeId,
          revision: 1,
          seedVersion: null,
          createdBy: null,
          updatedBy: null,
          createdAt: 0,
          updatedAt: 0,
        },
        row.properties,
      );
    }
  }
}
function checkEdges(
  file: TransferFile,
  nodes: Map<string, { archived: boolean }>,
  cache: Map<string, EntityRecord>,
  mapped: (type: string, id: string) => string,
) {
  for (const { id: edgeId, ...edge } of file.edges) {
    if (edge.fromId === edge.toId)
      throw new Error(`Self relationship ${edgeId} is not allowed`);
    const existing = cache.get(`graph-edge/${mapped("graph-edge", edgeId)}`);
    if (
      existing &&
      equal(fields(existing), {
        ...edge,
        typeId: mapped("graph-type", edge.typeId),
        fromId: mapped("graph-node", edge.fromId),
        toId: mapped("graph-node", edge.toId),
      })
    )
      continue;
    for (const id of [edge.fromId, edge.toId]) {
      const node = nodes.get(mapped("graph-node", id));
      if (!node)
        throw new Error(`Missing endpoint ${id}; include its seed file`);
      if (node.archived)
        throw new Error(
          `Relationship ${edgeId} has archived endpoint ${id}; restore the endpoint before importing this relationship`,
        );
    }
  }
}
function validateDependencies(
  file: TransferFile,
  cache: Map<string, EntityRecord>,
  mapped: (type: string, id: string) => string,
) {
  const types = new Map<string, z.infer<typeof typeInput>>();
  const nodes = new Map<string, { archived: boolean }>();
  for (const record of cache.values()) {
    if (record.ref.type === "graph-type")
      types.set(record.ref.id, typeInput.parse(fields(record)));
    if (record.ref.type === "graph-node")
      nodes.set(record.ref.id, nodeInput.parse(fields(record)));
  }
  for (const type of file.types) types.set(mapped("graph-type", type.id), type);
  for (const node of [...file.nodes, ...file.projects])
    nodes.set(mapped("graph-node", node.id), node);
  checkRecordTypes(file, types, cache, mapped);
  checkEdges(file, nodes, cache, mapped);
}
async function createRecord(
  call: Call,
  journal: Journal,
  save: () => Promise<void>,
  pending: NonNullable<Journal["pending"]>,
) {
  journal.pending = pending;
  await save();
  const { key: _key, ...args } = pending;
  try {
    return (await call("create_entity", args)) as EntityRecord;
  } catch (error) {
    if (error instanceof ToolRefusal) {
      delete journal.pending;
      await save();
    }
    throw error;
  }
}
export async function resolvePending(
  call: Call,
  journal: Journal,
  remoteId: string,
) {
  const pending = journal.pending;
  if (!pending) throw new Error("No pending create to resolve");
  const record = (await call("get_entity", {
    installationId: pending.installationId,
    type: pending.type,
    id: remoteId,
  })) as EntityRecord;
  if (
    !Object.entries(pending.attributes).every(([key, value]) =>
      equal(value, record.attributes[key]),
    ) ||
    !equal(pending.references ?? [], record.references)
  )
    throw new Error("Selected record does not match the pending create");
  journal.entries[pending.key] = {
    ref: record.ref,
    base: pending.attributes,
    references: record.references,
  };
  delete journal.pending;
}
async function updateRecord(
  call: Call,
  key: string,
  remote: EntityRecord,
  attributes: Record<string, unknown>,
  references: EntityRef[],
  journal: Journal,
  save: () => Promise<void>,
  apply: boolean,
) {
  if (!equal(remote.references, references))
    throw new Error(`Canonical reference conflict for ${key}`);
  const patch = changes(attributes, fields(remote), journal.entries[key]?.base);
  if (!Object.keys(patch).length) return false;
  if (apply) {
    const saved = (await call("update_entity", {
      ...remote.ref,
      revision: remote.revision,
      attributes: patch,
      references,
    })) as EntityRecord;
    journal.entries[key] = {
      ref: saved.ref,
      base: attributes,
      references: saved.references,
    };
    await save();
  }
  return true;
}

export async function uploadFile(
  call: Call,
  file: TransferFile,
  journal: Journal,
  save: () => Promise<void>,
  apply = false,
) {
  if (journal.pending)
    throw new Error(
      `Uncertain create ${journal.pending.key}; reconcile its saved receipt before retrying. No writes attempted.`,
    );
  const cache = new Map<string, EntityRecord>();
  for (const type of ["graph-type", "graph-node", "graph-edge"]) {
    for (const row of await listAll(call, journal.wiki, type))
      cache.set(`${type}/${row.ref.id}`, row);
  }
  const counts = { create: 0, update: 0, unchanged: 0 };
  const mapped = (type: string, id: string) =>
    journal.entries[`${type}/${id}`]?.ref.id ?? id;
  async function write(
    type: string,
    id: string,
    attributes: Record<string, unknown>,
    references: EntityRef[] = [],
    installationId = journal.wiki,
  ) {
    const key = `${type}/${id}`,
      entry = journal.entries[key];
    const remote = cache.get(`${type}/${entry?.ref.id ?? id}`);
    if (entry && !remote && type !== "project")
      throw new Error(
        `Previously uploaded ${key} is missing; refusing to recreate it`,
      );
    if (remote) {
      const updated = await updateRecord(
        call,
        key,
        remote,
        attributes,
        references,
        journal,
        save,
        apply,
      );
      counts[updated ? "update" : "unchanged"]++;
      return remote.ref;
    }
    counts.create++;
    if (!apply) return { installationId, type, id };
    // Persist before sending: a lost create response must never trigger a blind duplicate.
    const saved = await createRecord(call, journal, save, {
      key,
      type,
      installationId,
      attributes,
      references,
    });
    journal.entries[key] = {
      ref: saved.ref,
      base: type === "project" ? saved.attributes : fields(saved),
      references: saved.references,
    };
    delete journal.pending;
    await save();
    cache.set(`${type}/${saved.ref.id}`, saved);
    return saved.ref;
  }
  if (file.projects.length && !journal.planning)
    throw new Error(
      "Project imports require --planning; Wiki-only files and exports do not",
    );
  validateDependencies(file, cache, mapped);
  for (const { id, ...attributes } of file.types)
    await write("graph-type", id, attributes);
  for (const project of file.projects) {
    const key = `project/${project.id}`;
    let ref: EntityRef | undefined = journal.entries[key]?.ref;
    const existing = cache.get(
      `graph-node/${mapped("graph-node", project.id)}`,
    );
    ref ??= existing?.references[0];
    if (!ref && project.source?.installationId === journal.planning) {
      const record = (await call("get_entity", {
        ...project.source,
      })) as EntityRecord;
      ref = record.ref;
    }
    ref ??= await write(
      "project",
      project.id,
      { name: project.title },
      [],
      journal.planning,
    );
    const { id, source: _source, ...attributes } = project;
    await write(
      "graph-node",
      id,
      { ...attributes, typeId: mapped("graph-type", attributes.typeId) },
      [ref],
    );
  }
  for (const { id, ...attributes } of file.nodes)
    await write("graph-node", id, {
      ...attributes,
      typeId: mapped("graph-type", attributes.typeId),
    });
  for (const { id, ...attributes } of file.edges)
    await write("graph-edge", id, {
      ...attributes,
      typeId: mapped("graph-type", attributes.typeId),
      fromId: mapped("graph-node", attributes.fromId),
      toId: mapped("graph-node", attributes.toId),
    });
  return counts;
}
