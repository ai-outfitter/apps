import { z } from "zod";
import { requestIdentity, type AppIdentity } from "./server";
import { defineOperation, operationAPI, type AppOperation } from "./operations";
import { schemaJSON } from "./agent-schema";

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
  writable: z.boolean(),
  operations: z.array(z.enum(["list", "get", "create", "update"])).optional(),
});
export const entityQuery = z.strictObject({
  type: key,
  filter: z.record(z.string().min(1).max(128), z.json()).optional().describe("Match the provider filterSchema from entities.types. Unsupported or unknown filters are errors."),
  order: z.strictObject({ field: key, direction: z.enum(["asc", "desc"]) }).optional(),
  select: z.array(key).min(1).max(32).refine(fields => new Set(fields).size === fields.length).optional(),
  offset: z.number().int().nonnegative().max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const entityWrite = z.strictObject({
  type: key,
  attributes: z.record(z.string(), z.json()),
  references: z.array(entityRef).max(32).default([]),
});
export const entityUpdate = entityWrite.extend({ id: key, revision: z.number().int().positive() });
export const entityGet = z.strictObject({ type: key, id: key });

export type EntityOperation = "list" | "get" | "create" | "update";
export type EntityProvider = {
  type: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  filterSchema?: z.ZodObject;
  collection?: string;
  orderFields?: readonly string[];
  selectFields?: readonly string[];
  /** Additional app policy; defaults to members reading and editors writing. */
  can?: (identity: AppIdentity, operation: EntityOperation) => boolean;
  list: (identity: AppIdentity, offset: number, limit: number, filter?: Record<string, unknown>, order?: z.output<typeof entityQuery>["order"]) => Promise<EntityRecord[]>;
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
        writable: allowed(p, who, "create") || allowed(p, who, "update"),
        operations: (["list", "get", "create", "update"] as const).filter(op => allowed(p, who, op)),
      })),
    }),
    list: defineOperation({
      method: "POST", input: entityQuery, output: z.array(entityRecord).max(100), authorize: authorize("list"),
      run: async (who, input) => {
        const provider = find(input.type);
        if (input.order && !provider.orderFields?.includes(input.order.field)) throw new Response("Unsupported entity ordering", { status: 400 });
        if (input.select?.some(field => !provider.selectFields?.includes(field))) throw new Response("Unsupported entity selection", { status: 400 });
        let filter: Record<string, unknown> | undefined;
        if (input.filter !== undefined) {
          if (!provider.filterSchema) throw new Response("This entity type does not support filters", { status: 400 });
          const parsed = provider.filterSchema.strict().safeParse(input.filter);
          if (!parsed.success) throw new Response(`Invalid entity filter: ${z.prettifyError(parsed.error).slice(0, 1000)}`, { status: 400 });
          filter = parsed.data;
        }
        const records = await provider.list(who, input.offset, input.limit, filter, input.order);
        const select = input.select;
        return select ? records.map(record => ({ ...record, attributes: Object.fromEntries(select.filter(field => Object.hasOwn(record.attributes, field)).map(field => [field, record.attributes[field]])) })) : records;
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

/** Mount behind dataAppMiddleware. The platform alone calls this reserved route. */
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
  name(row: Row): string;
  attributes?(row: Row): unknown;
  outputAttributes?(row: Row): Record<string, z.output<typeof z.json>>;
  references?(row: Row, identity: AppIdentity): EntityRef[];
  can?: EntityProvider["can"];
  list(identity: AppIdentity, offset: number, limit: number, filter?: z.output<Filter>, order?: z.output<typeof entityQuery>["order"]): Promise<Row[]>;
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
    type: definition.type, title: definition.title, description: definition.description, schema: definition.schema, filterSchema: definition.filterSchema, collection: definition.collection, orderFields: definition.orderFields, selectFields: definition.selectFields, can: definition.can,
    list: async (who, offset, limit, filter, order) => (await definition.list(who, offset, limit, filter as z.output<Filter> | undefined, order)).map(row => record(who, row)),
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
