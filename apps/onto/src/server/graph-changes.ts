import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import {
  type AppIdentity,
  isUniqueViolation,
  requireEditor,
  requireEntityWriter,
  sha256Hex,
} from "@ai-outfitter/app-sdk/server";
import { ontologyContract } from "@ai-outfitter/onto/contracts";
import { and, eq, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { refreshKnowledgeGraphQueries } from "./knowledge-graph-refresh";
import { z } from "zod";
import { canonical } from "../lib/canonical-json";
import {
  core,
  edgeInput,
  freeSlug,
  type Graph,
  nodeInput,
  slugify,
  typeInput,
} from "../lib/graph";
import { v2 } from "../lib/ontology-model";
import { requireOntologyValid } from "../lib/ontology-validation";
import { storeType } from "../lib/type-metadata";
import { checkProperties, graphUnchanged, readGraph } from "./graph";
import { handleIndex, resolveHandle } from "../lib/record-handles";
import type { TypeRow } from "@ai-outfitter/app-sdk/graph-graphql";
import { validateKnowledgeGraph, withCompiledQuery } from "../lib/knowledge-graph-document";
import { graphChanges } from "./schema";

import { graphChangeInput, graphChangeReceipt } from "@ai-outfitter/onto/contracts";
export { graphChangeInput, graphChangeReceipt } from "@ai-outfitter/onto/contracts";
type Input = z.infer<typeof graphChangeInput>;
type Receipt = z.infer<typeof graphChangeReceipt>;
type Change = Input["operations"][number];
type Database = ReturnType<typeof installationDatabase>;
const schemas = {
  "graph-type": typeInput,
  "graph-node": nodeInput,
  "graph-edge": edgeInput,
};
const records = (graph: Graph) => ({
  "graph-type": graph.types,
  "graph-node": graph.nodes,
  "graph-edge": graph.edges,
});
function fail(message: string, status = 400): never {
  throw new Response(message, { status });
}


type SavedRow =
  Graph["types"][number] | Graph["nodes"][number] | Graph["edges"][number];
type Refs = Map<string, { id: string; type: Change["type"] }>;
type Handles = ReturnType<typeof handleIndex>;
function resolveAssertionSubjects(
  graph: Graph,
  changes: Record<
    "graph-type" | "graph-node" | "graph-edge",
    Record<string, unknown>[]
  >,
  refs: Refs,
  handles: Handles,
) {
  const types = new Map(
    [...graph.types, ...changes["graph-type"]].map((type) => [
      String(type.id),
      type,
    ]),
  );
  for (const node of changes["graph-node"]) {
    const contract = ontologyContract.safeParse(
      types.get(String(node.typeId))?.ontology,
    );
    if (!contract.success || v2(contract.data)?.stereotype !== "assertion")
      continue;
    resolveSubject(node, refs, handles);
  }
}
function resolveSubject(
  node: Record<string, unknown>,
  refs: Refs,
  handles: Handles,
) {
  let body: { subject?: { id?: unknown; type?: unknown } };
  try {
    body = JSON.parse(String(node.body));
  } catch {
    return;
  }
  const subject = body?.subject;
  if (typeof subject?.id !== "string") return;
  if (!subject.id.startsWith("$")) {
    if (subject.type !== "graph-node" && subject.type !== "graph-edge") return;
    const id = resolveHandle(handles, subject.type, subject.id);
    if (id === subject.id) return;
    subject.id = id;
    node.body = JSON.stringify(body);
    return;
  }
  const ref = refs.get(subject.id);
  if (!ref || ref.type !== subject.type)
    throw new Response("Unknown or incompatible assertion subject reference", {
      status: 400,
    });
  subject.id = ref.id;
  node.body = JSON.stringify(body);
}


const referenceFields: Record<
  Change["type"],
  Record<string, Change["type"]>
> = {
  "graph-type": {},
  "graph-node": { typeId: "graph-type" },
  "graph-edge": {
    typeId: "graph-type",
    fromId: "graph-node",
    toId: "graph-node",
  },
};
function resolveAttributes(change: Change, refs: Refs, handles: Handles) {
  const attributes = { ...change.attributes };
  for (const [field, expected] of Object.entries(
    referenceFields[change.type],
  )) {
    const value = attributes[field];
    if (typeof value !== "string") continue;
    if (!value.startsWith("$")) {
      attributes[field] = resolveHandle(handles, expected, value);
      continue;
    }
    const ref = refs.get(value);
    if (!ref || ref.type !== expected)
      fail(`Unknown or incompatible temporary reference: ${value}`);
    attributes[field] = ref.id;
  }
  return attributes;
}

function allocateReferences(operations: Input["operations"], handles: Handles) {
  const refs: Refs = new Map();
  const targets = new Set<string>();
  for (const change of operations) {
    if (refs.has(change.ref)) fail("Duplicate temporary reference");
    const parsedId = z
      .uuid()
      .safeParse(
        change.operation === "update"
          ? resolveHandle(handles, change.type, change.id)
          : (change.attributes.id ?? crypto.randomUUID()),
      );
    if (!parsedId.success) fail("Invalid record ID");
    const id = parsedId.data;
    const target = `${change.type}:${id}`;
    if (targets.has(target)) fail("A record can appear only once per batch");
    targets.add(target);
    refs.set(change.ref, { id, type: change.type });
  }
  return refs;
}

const provenance = (saved: SavedRow | undefined, who: AppIdentity) => ({
  revision: (saved?.revision ?? 0) + 1,
  createdBy: saved ? saved.createdBy : who.userId,
  createdAt: saved ? saved.createdAt : Date.now(),
  updatedBy: who.userId,
  updatedAt: Date.now(),
});

function prepareRow(
  change: Change,
  id: string,
  saved: SavedRow | undefined,
  refs: Refs,
  handles: Handles,
  who: AppIdentity,
) {
  if (
    change.operation === "update" &&
    (!saved || saved.revision !== change.revision)
  )
    fail("Record changed; read its current revision before retrying", 409);
  if (change.operation === "create" && saved)
    fail("Record already exists; use an update", 409);
  if (change.attributes.id !== undefined && change.attributes.id !== id)
    fail("Record IDs are immutable", 409);
  const schema = schemas[change.type];
  const previous = saved
    ? Object.fromEntries(
        Object.keys(schema.shape)
          .filter((key) => key in saved)
          .map((key) => [key, saved[key as keyof typeof saved]]),
      )
    : {};
  const parsed = schema.safeParse({
    ...previous,
    ...resolveAttributes(change, refs, handles),
    id,
  });
  if (!parsed.success)
    fail(
      `Invalid ${change.type}: ${z.prettifyError(parsed.error).slice(0, 1000)}`,
    );
  const row: Record<string, unknown> = {
    ...parsed.data,
    id,
    ...provenance(saved, who),
  };
  return row;
}

function prepareNode(
  row: Record<string, unknown>,
  saved: SavedRow | undefined,
  slugs: Set<string>,
) {
  if (saved && "source" in saved && saved.source)
    fail("Use the scoped entity API for canonical app records");
  if (saved && "typeId" in saved && saved.typeId !== row.typeId)
    fail("Keep the entity's type");
  row.slug ??= freeSlug(slugify(String(row.title)), slugs);
  slugs.add(String(row.slug));
}

function prepareChanges(input: Input, graph: Graph, who: AppIdentity) {
  const current = records(graph);
  const handles = handleIndex(graph);
  const refs = allocateReferences(input.operations, handles);
  const slugs = new Set([
    ...graph.nodes.map((node) => node.slug!),
    ...input.operations.flatMap((change) =>
      change.type === "graph-node" && typeof change.attributes.slug === "string"
        ? [change.attributes.slug]
        : [],
    ),
  ]);
  const receipt: Receipt = {};
  const changes: Record<Change["type"], Record<string, unknown>[]> = {
    "graph-type": [],
    "graph-node": [],
    "graph-edge": [],
  };
  for (const change of input.operations) {
    const id = refs.get(change.ref)!.id;
    const saved = current[change.type].find((row) => row.id === id);
    const row = prepareRow(change, id, saved, refs, handles, who);
    if (change.type === "graph-node") prepareNode(row, saved, slugs);
    receipt[change.ref] = { id, revision: Number(row.revision) };
    changes[change.type].push(row);
  }
  resolveAssertionSubjects(graph, changes, refs, handles);
  return { changes, receipt };
}

function validateChanges(
  graph: Graph,
  changes: ReturnType<typeof prepareChanges>["changes"],
  receipt: Receipt,
) {
  const merge = (kind: Change["type"]) => {
    const rows = new Map<string, Record<string, unknown>>(
      records(graph)[kind].map((row) => [row.id, row]),
    );
    for (const row of changes[kind]) rows.set(String(row.id), row);
    return [...rows.values()];
  };
  // Parsed records have the same domain fields; provenance does not affect validation.
  const final = {
    types: merge("graph-type"),
    nodes: merge("graph-node"),
    edges: merge("graph-edge"),
  } as unknown as Graph;
  for (const type of final.types.filter((type) =>
    changes["graph-type"].some((row) => row.id === type.id),
  )) {
    if (
      new Set(type.properties.map((property) => property.name)).size !==
      type.properties.length
    )
      fail("Property names must be unique");
  }
  requireOntologyValid(
    graph,
    final,
    new Map(Object.entries(receipt).map(([ref, row]) => [row.id, ref])),
  );
  validateNodes(final, changes["graph-node"], changes["graph-type"]);
  validateEdges(final, changes["graph-edge"], changes["graph-type"]);
}

/** Written KnowledgeGraphs store what their selection compiles to over the batch's final types. */
function compileKnowledgeGraphs(graph: Graph, changes: ReturnType<typeof prepareChanges>["changes"]) {
  const written = new Map(changes["graph-type"].map((row) => [String(row.id), row]));
  const types = [...graph.types.filter((type) => !written.has(type.id)), ...written.values()] as unknown as TypeRow[];
  changes["graph-node"] = changes["graph-node"].map((row) => (row.typeId === core.knowledgeGraph ? withCompiledQuery(row, types) : row));
}

function knowledgeGraphValid(final: Graph, node: Graph["nodes"][number]) {
  try { validateKnowledgeGraph(final, node); }
  catch (error) { fail(error instanceof Error ? `Invalid KnowledgeGraph: ${error.message}` : "Invalid KnowledgeGraph"); }
}
function validateNodes(
  final: Graph,
  changed: Record<string, unknown>[],
  changedTypes: Record<string, unknown>[],
) {
  const types = new Map(final.types.map((type) => [type.id, type]));
  for (const node of final.nodes.filter(
    (node) =>
      changed.some((row) => row.id === node.id) ||
      changedTypes.some((type) => type.id === node.typeId),
  )) {
    const type = types.get(node.typeId);
    if (!type || type.category !== "node") fail("Choose an existing node type");
    if (changed.some((row) => row.id === node.id) && type.archived)
      fail("Choose an active node type");
    checkProperties(
      type,
      node.properties,
      changed.some((row) => row.id === node.id) ? final.types : undefined,
    );
    if (node.typeId === core.knowledgeGraph && changed.some((row) => row.id === node.id)) knowledgeGraphValid(final, node);
  }
}

function validateEdges(
  final: Graph,
  changed: Record<string, unknown>[],
  changedTypes: Record<string, unknown>[],
) {
  const types = new Map(final.types.map((type) => [type.id, type]));
  const nodes = new Map(final.nodes.map((node) => [node.id, node]));
  for (const edge of final.edges.filter(
    (edge) =>
      changed.some((row) => row.id === edge.id) ||
      changedTypes.some((type) => type.id === edge.typeId),
  )) {
    const type = types.get(edge.typeId),
      from = nodes.get(edge.fromId),
      to = nodes.get(edge.toId);
    if (!type || type.category !== "edge" || !from || !to || from.id === to.id)
      fail("Invalid relationship type or endpoints");
    if (
      changed.some((row) => row.id === edge.id) &&
      (type.archived || (!edge.archived && (from.archived || to.archived)))
    )
      fail("Choose active relationship types and endpoints");
    checkProperties(type, edge.properties);
  }
}

/** How a commit is recorded in graph_revisions. graph.apply records a direct edit. */
export type ChangeHistory = {
  batchId?: string;
  proposedBy?: string;
  approval?: Record<string, unknown>;
  /** Batch operation ref for each graph.apply ref. */
  refs?: Record<string, string>;
  /** Citations for each graph.apply ref. */
  evidence?: Record<string, unknown[]>;
};

function historyStatement(
  graph: Graph,
  changes: ReturnType<typeof prepareChanges>["changes"],
  receipt: Receipt,
  who: AppIdentity,
  history: ChangeHistory,
  gate: ReturnType<typeof sql>,
) {
  const refById = new Map(Object.entries(receipt).map(([ref, row]) => [row.id, ref]));
  const now = Date.now();
  const rows = (Object.keys(changes) as Change["type"][]).flatMap((kind) =>
    changes[kind].map((row) => {
      const ref = refById.get(String(row.id)) ?? "";
      const prior = records(graph)[kind].find((saved) => saved.id === row.id) ?? null;
      return {
        kind, recordId: row.id, revision: row.revision,
        batchId: history.batchId ?? null, ref: history.refs?.[ref] ?? ref,
        proposedBy: history.proposedBy ?? who.userId,
        approval: JSON.stringify(history.approval ?? { kind: "direct", by: who.userId }),
        evidence: JSON.stringify(history.evidence?.[ref] ?? []),
        snapshot: JSON.stringify(row), prior: prior ? JSON.stringify(prior) : null, createdAt: now,
      };
    }),
  );
  return sql`INSERT INTO graph_revisions(kind,recordId,revision,batchId,ref,proposedBy,approval,evidence,snapshot,prior,createdAt)
    SELECT json_extract(value,'$.kind'),json_extract(value,'$.recordId'),json_extract(value,'$.revision'),json_extract(value,'$.batchId'),json_extract(value,'$.ref'),json_extract(value,'$.proposedBy'),json_extract(value,'$.approval'),json_extract(value,'$.evidence'),json_extract(value,'$.snapshot'),json_extract(value,'$.prior'),json_extract(value,'$.createdAt')
    FROM json_each(${JSON.stringify(rows)}) WHERE ${gate}
    ON CONFLICT(kind,recordId,revision) DO NOTHING`;
}

export async function applyGraphChanges(
  db: Database,
  who: AppIdentity,
  input: Input,
  history: ChangeHistory = {},
): Promise<Receipt> {
  requireEntityWriter(who);
  // Delegated apps may write data through the same policy as the entity API,
  // never change schemas, ontology definitions or configuration.
  if (input.operations.some((change) => change.type === "graph-type")) requireEditor(who);
  const hash = await sha256Hex(canonical(input));
  const savedReceipt = async () =>
    (
      await db
        .select()
        .from(graphChanges)
        .where(
          and(
            eq(graphChanges.userId, who.userId),
            eq(graphChanges.requestKey, input.requestKey),
          ),
        )
    )[0];
  const replay = (saved: typeof graphChanges.$inferSelect) => {
    if (saved.hash !== hash)
      fail("Request key already used with different changes", 409);
    return graphChangeReceipt.parse(saved.receipt);
  };
  const saved = await savedReceipt();
  if (saved) return replay(saved);
  const graph = await readGraph(db, who);
  // A concurrent identical request may have committed while the graph was read.
  const concurrent = await savedReceipt();
  if (concurrent) return replay(concurrent);
  for (const condition of input.preconditions ?? []) {
    const current = records(graph)[condition.type].find(row => row.id === condition.id);
    if (!current || current.revision !== condition.revision)
      fail("Graph precondition changed; refresh the source revisions", 409);
  }
  validateReadSets(graph, input.readSets ?? []);
  const { changes, receipt } = prepareChanges(input, graph, who);
  compileKnowledgeGraphs(graph, changes);
  validateChanges(graph, changes, receipt);
  const attempt = crypto.randomUUID();
  const gate = sql`EXISTS(SELECT 1 FROM graph_changes WHERE userId=${who.userId} AND requestKey=${input.requestKey} AND attempt=${attempt})`;
  const statements = [
    sql`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
      SELECT ${who.userId},${input.requestKey},${hash},${attempt},${JSON.stringify(receipt)}
      WHERE ${graphUnchanged(graph)}
      ON CONFLICT(userId,requestKey) DO NOTHING`,
    sql`INSERT INTO graph_types(id,category,name,title,body,properties,archived,revision,seedVersion,createdBy,updatedBy,createdAt,updatedAt)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.category'),json_extract(value,'$.name'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),json_extract(value,'$.revision'),json_extract(value,'$.seedVersion'),json_extract(value,'$.createdBy'),json_extract(value,'$.updatedBy'),json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt')
      FROM json_each(${JSON.stringify(changes["graph-type"].map((row) => storeType(row as unknown as z.infer<typeof typeInput>)))}) WHERE ${gate}
      ON CONFLICT(id) DO UPDATE SET category=excluded.category,name=excluded.name,title=excluded.title,body=excluded.body,properties=excluded.properties,archived=excluded.archived,revision=excluded.revision,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`,
    sql`INSERT INTO graph_nodes(id,typeId,slug,title,summary,body,website,properties,archived,revision,createdBy,updatedBy,createdAt,updatedAt,validity)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.slug'),json_extract(value,'$.title'),json_extract(value,'$.summary'),json_extract(value,'$.body'),json_extract(value,'$.website'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),json_extract(value,'$.revision'),json_extract(value,'$.createdBy'),json_extract(value,'$.updatedBy'),json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt'),json_extract(value,'$.validity')
      FROM json_each(${JSON.stringify(changes["graph-node"])}) WHERE ${gate}
      ON CONFLICT(id) DO UPDATE SET validity=excluded.validity,slug=excluded.slug,title=excluded.title,summary=excluded.summary,body=excluded.body,website=excluded.website,properties=excluded.properties,archived=excluded.archived,revision=excluded.revision,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`,
    sql`INSERT INTO graph_edges(id,typeId,fromId,toId,title,body,properties,archived,revision,createdBy,updatedBy,createdAt,updatedAt,validity)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.typeId'),json_extract(value,'$.fromId'),json_extract(value,'$.toId'),json_extract(value,'$.title'),json_extract(value,'$.body'),json_extract(value,'$.properties'),json_extract(value,'$.archived'),json_extract(value,'$.revision'),json_extract(value,'$.createdBy'),json_extract(value,'$.updatedBy'),json_extract(value,'$.createdAt'),json_extract(value,'$.updatedAt'),json_extract(value,'$.validity')
      FROM json_each(${JSON.stringify(changes["graph-edge"])}) WHERE ${gate}
      ON CONFLICT(id) DO UPDATE SET validity=excluded.validity,typeId=excluded.typeId,fromId=excluded.fromId,toId=excluded.toId,title=excluded.title,body=excluded.body,properties=excluded.properties,archived=excluded.archived,revision=excluded.revision,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`,
    historyStatement(graph, changes, receipt, who, history, gate),
  ];
  try {
    // D1 executes the ledger and all mutations in a single transaction. A failed
    // constraint rolls back the receipt too; a replay's attempt never opens the gate.
    await db.$client.batch(
      statements.map((statement) => {
        const compiled = new SQLiteSyncDialect().sqlToQuery(statement);
        return db.$client.prepare(compiled.sql).bind(...compiled.params);
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error))
      fail("Graph identity conflict; reconcile before retrying", 409);
    throw error;
  }
  const committed = await savedReceipt();
  if (!committed) fail("Graph changed during validation; retry the batch", 409);
  if (changes["graph-type"].length) await refreshKnowledgeGraphQueries(db);
  return replay(committed);
}

/** Validate changes against the current graph without writing anything. */
export async function checkGraphChanges(db: Database, who: AppIdentity, input: Input): Promise<Receipt> {
  requireEntityWriter(who);
  if (input.operations.some((change) => change.type === "graph-type")) requireEditor(who);
  const graph = await readGraph(db, who);
  for (const condition of input.preconditions ?? []) {
    const current = records(graph)[condition.type].find(row => row.id === condition.id);
    if (!current || current.revision !== condition.revision)
      fail("Graph precondition changed; refresh the source revisions", 409);
  }
  validateReadSets(graph, input.readSets ?? []);
  const { changes, receipt } = prepareChanges(input, graph, who);
  compileKnowledgeGraphs(graph, changes);
  validateChanges(graph, changes, receipt);
  return receipt;
}

function validateReadSets(graph: Graph, readSets: NonNullable<Input["readSets"]>) {
  for (const expected of readSets) {
    const current = records(graph)[expected.type]
      .filter(row => {
        if (row.typeId !== expected.typeId || (!expected.includeArchived && row.archived)) return false;
        if (!expected.endpoint) return true;
        if (!("fromId" in row) || !("toId" in row)) return false;
        const endpoint = expected.endpoint.direction === "outgoing" ? row.fromId : row.toId;
        return endpoint === expected.endpoint.nodeId;
      })
      .map(row => ({ id: row.id, revision: row.revision }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const saved = [...expected.records].sort((a, b) => a.id.localeCompare(b.id));
    if (canonical(current) !== canonical(saved)) fail("Graph source membership changed; refresh the source revisions", 409);
  }
}
