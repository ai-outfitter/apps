import { z } from "zod";
import { requestIdentity, type AppIdentity } from "./server";
import { defineOperation, operationAPI, type AppOperation } from "./operations";
import { schemaJSON } from "./agent-schema";
import { type SearchExpression, searchBinds, searchExpression } from "./entity-query";

/** App-owned records, addressed independently of browser routes or database tables. */
export const entityPath = "/api/internal/entities/v1";
export const entityCapability = "entities.publish";
const key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const entityRef = z.strictObject({ installationId: key, type: key, id: key });
export type EntityRef = z.infer<typeof entityRef>;
export const entityRecord = z.strictObject({
  ref: entityRef,
  revision: z.number().int().positive(),
  title: z.string().max(200),
  attributes: z.record(z.string(), z.json()),
  references: z.array(entityRef).max(32).default([]),
});
export type EntityRecord = z.infer<typeof entityRecord>;
export const entityType = z.strictObject({
  type: key,
  title: z.string().max(200),
  description: z.string().max(2000),
  schema: z.record(z.string(), z.json()),
  filterSchema: z.record(z.string(), z.json()).optional(),
  collection: key.optional(),
  orderFields: z.array(key).optional(),
  selectFields: z.array(key).optional(),
  searchFields: z.array(key).optional(),
  writable: z.boolean(),
  operations: z.array(z.enum(["list", "get", "create", "update"])).optional(),
});
export const entityOrder = z.strictObject({ field: key, direction: z.enum(["asc", "desc"]) });
export const entityQuery = z.strictObject({
  type: key,
  ids: z.array(key).min(1).max(100).optional().describe("Known record IDs, read in one indexed lookup."),
  search: z.string().trim().min(1).max(512).optional().describe("Text over the type's searchFields: terms, quoted phrases, AND, OR, NOT and parentheses; adjacent terms mean AND."),
  filter: z.record(z.string().min(1).max(128), z.json()).optional().describe("Match the provider filterSchema from entities.types. Unsupported or unknown filters are errors."),
  order: entityOrder.optional().describe("One of the type's orderFields, or id; ties break by id. Default id ascending."),
  select: z.array(key).min(1).max(32).refine(fields => new Set(fields).size === fields.length).optional(),
  after: z.string().min(1).max(1024).optional().describe("pageInfo.endCursor of the previous page, with the same query."),
  limit: z.number().int().min(1).max(100).default(50),
});
export const entityPageInfo = z.strictObject({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
export const entityPage = z.strictObject({ records: z.array(entityRecord).max(100), pageInfo: entityPageInfo });
export type EntityPage = z.infer<typeof entityPage>;
export const entityWrite = z.strictObject({
  type: key,
  attributes: z.record(z.string(), z.json()),
  references: z.array(entityRef).max(32).default([]),
});
export const entityUpdate = entityWrite.extend({ id: key, revision: z.number().int().positive() });
export const entityGet = z.strictObject({ type: key, id: key });

export type EntityOperation = "list" | "get" | "create" | "update";
type CursorValue = string | number | boolean | null;
/** One page a provider reads in its own database: at most `limit` rows (the page plus one, so the SDK
 * knows whether more follow) of the known `ids`, matching `search` over its searchFields and its
 * typed `filter`, in `order` then ID, strictly after the row `after` names. */
export type EntityListQuery<Filter = Record<string, unknown>> = {
  limit: number;
  ids?: string[];
  search?: SearchExpression;
  filter?: Filter;
  order: z.output<typeof entityOrder>;
  after?: { value: CursorValue; id: string };
};
/** What entityOperations hands a provider: the cursor still encoded, since only the provider knows its rows. */
export type EntityProviderQuery = Omit<EntityListQuery, "after"> & { after?: string };
const cursorKey = z.strictObject({ f: key, d: z.enum(["asc", "desc"]), v: z.union([z.string(), z.number(), z.boolean(), z.null()]), i: key });
const encodeCursor = (value: z.infer<typeof cursorKey>) => btoa(encodeURIComponent(JSON.stringify(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string, order: z.output<typeof entityOrder>): EntityListQuery["after"] {
  let parsed: z.infer<typeof cursorKey>;
  try { parsed = cursorKey.parse(JSON.parse(decodeURIComponent(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))))); }
  catch { throw new Response("Invalid entity cursor", { status: 400 }); }
  if (parsed.f !== order.field || parsed.d !== order.direction) throw new Response("This cursor belongs to another ordering; keep order unchanged while paging", { status: 400 });
  return { value: parsed.v, id: parsed.i };
}
export type EntityProvider = {
  type: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  filterSchema?: z.ZodObject;
  collection?: string;
  orderFields?: readonly string[];
  selectFields?: readonly string[];
  /** The fields `search` matches; a type without them refuses search. */
  searchFields?: readonly string[];
  /** Additional app policy; defaults to members reading and editors writing. */
  can?: (identity: AppIdentity, operation: EntityOperation) => boolean;
  /** One page in the provider's own database; the query's `limit` is the page size (defineEntity reads one more). */
  list: (identity: AppIdentity, query: EntityProviderQuery) => Promise<EntityPage>;
  get: (identity: AppIdentity, id: string) => Promise<EntityRecord>;
  create?: (identity: AppIdentity, attributes: Record<string, unknown>, references: EntityRef[]) => Promise<EntityRecord>;
  update?: (identity: AppIdentity, id: string, revision: number, attributes: Record<string, unknown>, references: EntityRef[]) => Promise<EntityRecord>;
};

const allowed = (provider: EntityProvider, who: AppIdentity, operation: EntityOperation) =>
  typeof provider[operation] === "function" &&
  (operation === "list" || operation === "get" || who.canEdit || !!who.entityWriter) &&
  (provider.can?.(who, operation) ?? true);

/** Drop create defaults before parsing a partial update. */
function patchSchema(schema: z.ZodObject) {
  return z.strictObject(Object.fromEntries(Object.entries(schema.shape).map(([name, field]) => {
    const value = field as z.ZodType;
    return [name, (value instanceof z.ZodDefault ? value.removeDefault() as z.ZodType : value).optional()];
  })));
}

/** Entity operations are one consumer of the generic app-operation dispatcher. */
export function entityOperations(providers: EntityProvider[]): Record<string, AppOperation<AppIdentity>> {
  if (new Set(providers.map(p => p.type)).size !== providers.length) throw new Error("Duplicate entity type");
  const find = (type: string) => {
    const provider = providers.find(p => p.type === type);
    if (!provider) throw new Response("Entity type not found", { status: 404 });
    return provider;
  };
  const authorize = (operation: EntityOperation) => (who: AppIdentity, input: { type: string }) => {
    if (!allowed(find(input.type), who, operation)) throw new Response("Entity operation not allowed", { status: 403 });
  };
  return {
    types: defineOperation({
      method: "GET", input: z.strictObject({}), output: z.array(entityType),
      authorize: (_who: AppIdentity) => {},
      run: (who) => providers.filter(p => allowed(p, who, "list") || allowed(p, who, "get")).map(p => ({
        type: p.type, title: p.title, description: p.description, schema: schemaJSON(p.schema),
        ...(p.filterSchema ? { filterSchema: schemaJSON(p.filterSchema.strict()) } : {}),
        ...(p.collection ? { collection: p.collection, orderFields: p.orderFields ?? [], selectFields: p.selectFields ?? [] } : {}),
        ...(p.searchFields?.length ? { searchFields: [...p.searchFields] } : {}),
        writable: allowed(p, who, "create") || allowed(p, who, "update"),
        operations: (["list", "get", "create", "update"] as const).filter(op => allowed(p, who, op)),
      })),
    }),
    list: defineOperation({
      method: "POST", input: entityQuery, output: entityPage, authorize: authorize("list"),
      run: async (who, input) => {
        const provider = find(input.type);
        const page = await provider.list(who, providerQuery(provider, input));
        return input.select ? { ...page, records: page.records.map(record => selected(record, input.select as string[])) } : page;
      },
    }),
    get: defineOperation({
      method: "POST", input: entityGet, output: entityRecord, authorize: authorize("get"),
      run: (who, input) => find(input.type).get(who, input.id),
    }),
    create: defineOperation({
      method: "POST", input: entityWrite, output: entityRecord, authorize: authorize("create"),
      run: (who, input) => mutateEntity(find(input.type), who, input),
    }),
    update: defineOperation({
      method: "POST", input: entityUpdate, output: entityRecord, authorize: authorize("update"),
      run: (who, input) => mutateEntity(find(input.type), who, input),
    }),
  };
}

const refuse = (message: string) => new Response(message, { status: 400 });
const selected = (record: EntityRecord, fields: string[]) =>
  ({ ...record, attributes: Object.fromEntries(fields.filter(field => Object.hasOwn(record.attributes, field)).map(field => [field, record.attributes[field]])) });
/** The provider's view of a list request, refusing what the type does not advertise. */
function providerQuery(provider: EntityProvider, input: z.output<typeof entityQuery>): EntityProviderQuery {
  const order = input.order ?? { field: "id", direction: "asc" as const };
  if (order.field !== "id" && !provider.orderFields?.includes(order.field)) throw refuse("Unsupported entity ordering");
  if (input.select?.some(field => !provider.selectFields?.includes(field))) throw refuse("Unsupported entity selection");
  const query: EntityProviderQuery = { limit: input.limit, order, filter: providerFilter(provider, input.filter) };
  if (input.ids) query.ids = input.ids;
  if (input.after) query.after = input.after;
  if (input.search) query.search = providerSearch(provider, input.type, input.search);
  return query;
}
function providerSearch(provider: EntityProvider, type: string, search: string) {
  if (!provider.searchFields?.length) throw refuse(`${type} does not support search; filter it instead`);
  const expression = searchExpression(search);
  // D1 binds at most 100 parameters a statement: each term binds once per searchable field.
  if (searchBinds(expression, provider.searchFields.length) > 60) throw refuse("Search has too many terms for this type; use fewer");
  return expression;
}
function providerFilter(provider: EntityProvider, filter: Record<string, unknown> | undefined) {
  if (filter === undefined) return undefined;
  if (!provider.filterSchema) throw refuse("This entity type does not support filters");
  const parsed = provider.filterSchema.strict().safeParse(filter);
  if (!parsed.success) throw refuse(`Invalid entity filter: ${z.prettifyError(parsed.error).slice(0, 1000)}`);
  return parsed.data;
}

/** Mount behind the outfitterApp() middleware. The platform alone calls this reserved route. */
export function entityAPI(request: Request, operation: string, providers: EntityProvider[]) {
  return operationAPI(request, operation, entityOperations(providers), () => requestIdentity(request));
}

async function mutateEntity(provider: EntityProvider, identity: AppIdentity, input: z.output<typeof entityWrite> | z.output<typeof entityUpdate>) {
  const update = "revision" in input;
  const parsed = (update ? patchSchema(provider.schema) : provider.schema).safeParse(input.attributes);
  if (!parsed.success) throw new Response("Invalid entity attributes", { status: 400 });
  // Defaults may also be nested under optional/nullable wrappers. Only fields
  // explicitly present in the amendment can become changed attributes.
  const changes = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => Object.hasOwn(input.attributes, key)));
  if (update && provider.update) return provider.update(identity, input.id, input.revision, changes, input.references);
  if (!update && provider.create) return provider.create(identity, parsed.data, input.references);
  throw new Response("Entity operation not allowed", { status: 403 });
}

/** An adapter over app-owned records, not a persistence layer. Apps supply
 * queries and atomic domain writes; the SDK handles serialization and patches. */
export function defineEntity<Row extends { id: string; revision: number }, Schema extends z.ZodObject, Filter extends z.ZodObject = z.ZodObject>(definition: {
  type: string;
  title: string;
  description: string;
  schema: Schema;
  filterSchema?: Filter;
  collection?: string;
  orderFields?: readonly string[];
  selectFields?: readonly string[];
  searchFields?: readonly string[];
  name(row: Row): string;
  attributes?(row: Row): unknown;
  outputAttributes?(row: Row): Record<string, z.output<typeof z.json>>;
  references?(row: Row, identity: AppIdentity): EntityRef[];
  can?: EntityProvider["can"];
  /** At most `query.limit` rows, in `query.order` then ID, after `query.after` (pageCondition builds
   * that for a drizzle table). */
  list(identity: AppIdentity, query: EntityListQuery<z.output<Filter>>): Promise<Row[]>;
  get(identity: AppIdentity, id: string): Promise<Row>;
  create?(identity: AppIdentity, attributes: z.output<Schema>, references: EntityRef[]): Promise<Row>;
  update?(identity: AppIdentity, current: Row, attributes: z.output<Schema>, revision: number, references: EntityRef[]): Promise<Row>;
}): EntityProvider {
  const fields = (row: Row) => definition.schema.parse(definition.attributes ? definition.attributes(row)
    : Object.fromEntries(Object.keys(definition.schema.shape).filter(key => key in row).map(key => [key, (row as Record<string, unknown>)[key]])));
  const record = (who: AppIdentity, row: Row): EntityRecord => entityRecord.parse({
    ref: { installationId: who.installationId, type: definition.type, id: row.id },
    title: definition.name(row), revision: row.revision, attributes: { ...fields(row), ...definition.outputAttributes?.(row) }, references: definition.references?.(row, who) ?? [],
  });
  const { create, update } = definition;
  return {
    type: definition.type, title: definition.title, description: definition.description, schema: definition.schema, filterSchema: definition.filterSchema, collection: definition.collection, orderFields: definition.orderFields, selectFields: definition.selectFields, searchFields: definition.searchFields, can: definition.can,
    list: async (who, { after, ...query }) => {
      const rows = await definition.list(who, { ...query, filter: query.filter as z.output<Filter> | undefined, limit: query.limit + 1, ...(after ? { after: decodeCursor(after, query.order) } : {}) });
      const kept = rows.slice(0, query.limit);
      const last = kept.at(-1);
      const value = (row: Row): CursorValue => {
        const field = (row as Record<string, unknown>)[query.order.field];
        return field === undefined ? null : field as CursorValue;
      };
      return {
        records: kept.map(row => record(who, row)),
        pageInfo: { hasNextPage: rows.length > query.limit, endCursor: rows.length > query.limit && last ? encodeCursor({ f: query.order.field, d: query.order.direction, v: value(last), i: last.id }) : null },
      };
    },
    get: async (who, id) => record(who, await definition.get(who, id)),
    ...(create ? { create: async (who: AppIdentity, attributes: Record<string, unknown>, references: EntityRef[]) =>
      record(who, await create(who, definition.schema.parse(attributes), references)) } : {}),
    ...(update ? { update: async (who: AppIdentity, id: string, revision: number, attributes: Record<string, unknown>, references: EntityRef[]) => {
      const current = await definition.get(who, id);
      if (current.revision !== revision) throw new Response("This entity changed; read it again before updating", { status: 409 });
      const merged = definition.schema.parse({ ...fields(current), ...attributes });
      return record(who, await update(who, current, merged, revision, references));
    } } : {}),
  };
}
