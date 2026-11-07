import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import {
  definitionFromResult, type EdgeRow, executeGraphQuery, type GraphGraphqlResult, type GraphRow, type GraphSource, queryHash, selectFromResult, selectionDocument,
  selectionVariables, type TypeRow,
} from "@ai-outfitter/app-sdk/graph-graphql";
import {
  type GraphSelectionDefinition,
  knowledgeGraphTypeId,
  retired,
  type KnowledgeGraphSelectInput,
  selectionResult,
} from "@ai-outfitter/app-sdk/graph-selection";
import { type KnowledgeGraphRenderInput, knowledgeGraphRenderInput, renderGraphTemplates } from "@ai-outfitter/app-sdk/graph-templates";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { wikiGraphRecords } from "@ai-outfitter/app-sdk/wiki";
import { knowledgeGraphDefinition, knowledgeGraphOperation, selectionReadBudget as readBudget, storedQuery } from "../lib/knowledge-graph-document";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";

/** An active KnowledgeGraph record's selection (null for a saved query) and stored query, or the 404/409 a caller should see. */
export function savedKnowledgeGraph(record: EntityRecord | null) {
  if (record?.attributes.typeId !== knowledgeGraphTypeId || record.attributes.archived || retired(record))
    throw new Response("KnowledgeGraph definition not found", { status: 404 });
  try { return { definition: knowledgeGraphDefinition(record), stored: storedQuery(record) }; }
  catch { throw new Response("KnowledgeGraph definition is invalid", { status: 409 }); }
}

/** An active KnowledgeGraph record's selection, for callers that walk it (graph.query expand). */
export function savedDefinition(record: EntityRecord | null) {
  const { definition } = savedKnowledgeGraph(record);
  if (!definition) throw new Response("This KnowledgeGraph is a saved GraphQL query without a selection; run its query with GraphQL", { status: 409 });
  return definition;
}

const transportBytes = 8 * 1024 * 1024 - 32 * 1024;

/** One stored node as an entity record, or null. */
async function storedRecord(source: GraphSource, installationId: string, id: string) {
  const [row] = await source.nodes({ ids: [id], archived: "include" });
  return row ? wikiGraphRecords({ installationId, types: [], nodes: [row as never], edges: [] }, true).nodes[0] ?? null : null;
}

type Saved = ReturnType<typeof storedQuery>;
type Document = { query: string; hash: string; variables: Record<string, unknown> };
const withHash = (query: string, variables: Record<string, unknown>): Document => ({ query, hash: queryHash(query), variables });

/** The selection compiled over this Wiki's schema, named after its KnowledgeGraph. */
function compile(definition: GraphSelectionDefinition | null | undefined, types: TypeRow[], record: EntityRecord | null) {
  try {
    if (!definition) throw new Error("No selection");
    const compiled = selectionDocument(definition, types, { operationName: record ? knowledgeGraphOperation(record) : undefined });
    return withHash(compiled.query, compiled.variables);
  } catch { throw new Response("KnowledgeGraph definition or roots are invalid", { status: 409 }); }
}

function readFailure(result: GraphGraphqlResult, handWritten: boolean): never {
  const messages = (result.errors ?? []).slice(0, 3).map(error => error.message).join("; ");
  const tooLarge = result.errors?.some(error => error.extensions?.code === "RESPONSE_TOO_LARGE");
  throw new Response(`The GraphQL document could not be read: ${messages}`, { status: tooLarge ? 413 : handWritten ? 400 : 409 });
}

type ReadArgs = { input: KnowledgeGraphSelectInput; definition: GraphSelectionDefinition | null | undefined; types: TypeRow[]; record: EntityRecord | null; stored: Saved; source: GraphSource };
/** Run the caller's query, else the record's stored query, else the selection compiled over
 * the live schema. A selection's stored query is kept current whenever types change
 * (knowledge-graph-refresh.ts), so it is the same document a page or agent runs by hash. */
async function readWith({ input, definition, types, record, stored, source }: ReadArgs) {
  const document = input.query ? withHash(input.query, selectionVariables)
    : stored ? withHash(stored.query, stored.variables) : compile(definition, types, record);
  const read = await executeGraphQuery({ types, source, query: document.query, variables: { rootIds: input.rootIds }, ...readBudget });
  return { document, read };
}

/** Full stored rows for the records a selection kept, so callers see what graph.read returns. */
async function hydrate(source: GraphSource, nodeIds: string[], edgeIds: string[]) {
  const [nodes, edges] = await Promise.all([
    nodeIds.length ? source.nodes({ ids: nodeIds, archived: "include" }) : Promise.resolve([] as GraphRow[]),
    edgeIds.length ? source.edges({ ids: edgeIds, archived: "include" }) : Promise.resolve([] as EdgeRow[]),
  ]);
  return { nodes, edges };
}

/** Read a selection through GraphQL: the compiled (or given) document runs over the Wiki's
 * tables, then the selection walk bounds what it returned. No whole-graph read. */
export async function selectKnowledgeGraphRecords(db: Database, who: AppIdentity, input: KnowledgeGraphSelectInput) {
  const source = databaseSource(db);
  const types = await source.types();
  let record: EntityRecord | null = null;
  let definition: GraphSelectionDefinition | null | undefined = input.definition;
  let stored: Saved = null;
  if (input.definitionId) {
    record = await storedRecord(source, who.installationId, input.definitionId);
    ({ definition, stored } = savedKnowledgeGraph(record));
  }
  if (definition && input.maxNodes) definition = { ...definition, maxNodes: Math.min(definition.maxNodes, input.maxNodes) };
  const { document, read } = await readWith({ input, definition, types, record, stored, source });
  if (read.errors?.length || read.data === null) readFailure(read, !!input.query);
  if (!definition) {
    try { definition = definitionFromResult(read.data, types, input.rootIds, { id: record ? `wiki:${record.ref.id}` : undefined, maxNodes: input.maxNodes ?? 200 }); }
    catch { throw new Response("The document returned none of the root nodes", { status: 404 }); }
  }
  // Roots as stored, so a retired root is hidden as the selection walk hides it.
  const roots = await source.nodes({ ids: input.rootIds, archived: "include" });
  let selection;
  try { selection = selectFromResult({ installationId: who.installationId, types, data: read.data, rootIds: input.rootIds, definition, records: roots }); }
  catch { throw new Response("KnowledgeGraph definition or roots are invalid", { status: 409 }); }
  if (!selection.roots.length) throw new Response("No root node matches the definition's root types", { status: 404 });
  const kept = await hydrate(source, selection.nodes.map(node => node.ref.id), selection.edges.map(edge => edge.ref.id));
  const full = wikiGraphRecords({ installationId: who.installationId, types: types as never, nodes: kept.nodes as never, edges: kept.edges as never }, true);
  const asStored = new Map([...full.nodes, ...full.edges].map(item => [item.ref.id, item]));
  const fuller = (items: EntityRecord[]) => items.map(item => asStored.get(item.ref.id) ?? item);
  // Lists cut to fit the read budget leave the selection incomplete, and say so.
  const truncated = !!read.extensions?.truncated;
  selection = { ...selection, roots: fuller(selection.roots), nodes: fuller(selection.nodes), edges: fuller(selection.edges), incomplete: selection.incomplete || truncated };
  const result = selectionResult(full, selection, record, document);
  if (new TextEncoder().encode(JSON.stringify(result)).length > transportBytes)
    throw new Response("Knowledge graph is too large; select a narrower lens", { status: 413 });
  return result;
}

/** Select, then flatten the selection through the caller's templates. Templates
 * read only the selected records, so the document never widens the view. */
export async function renderKnowledgeGraphRecords(db: Database, who: AppIdentity, raw: KnowledgeGraphRenderInput) {
  const { templates, parameters, ...select } = knowledgeGraphRenderInput.parse(raw);
  const selection = await selectKnowledgeGraphRecords(db, who, select);
  const document = renderGraphTemplates({
    installationId: who.installationId, types: selection.types, nodes: selection.nodes, edges: selection.edges,
    templates: templates.map((definition) => ({ definition })),
    parameters: { ...parameters, rootId: select.rootIds[0], rootIds: select.rootIds },
  });
  const sources = new Map(document.sources.map((source) => [source.ref.id, source]));
  for (const record of selection.types) sources.set(record.ref.id, { ref: record.ref, revision: record.revision });
  return {
    selection,
    document: {
      ...document,
      sources: [...sources.values()],
      complete: document.complete && !selection.incomplete && !selection.omitted.length && !selection.unresolved.length,
      unresolved: [...document.unresolved, ...selection.unresolved],
      omitted: selection.omitted,
    },
  };
}
