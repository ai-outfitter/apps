import { z } from "zod";
import { createUpdateSchema } from "drizzle-zod";
export {
  createSelectSchema,
  createInsertSchema,
  createUpdateSchema,
} from "drizzle-zod";
export type FieldSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, FieldSchema>;
  required?: string[];
  anyOf?: FieldSchema[];
  format?: string;
  maxLength?: number;
  readOnly?: boolean;
  [key: string]: unknown;
};
/** Select permissions explicitly; neither SQL types nor JSON Schema grant access. */
export function drizzleFields<
  T extends Parameters<typeof createUpdateSchema>[0],
>(table: T, fields: readonly string[]) {
  const shape = createUpdateSchema(table).shape as Record<string, z.ZodType>;
  return z.strictObject(
    Object.fromEntries(
      fields.map((key) => {
        if (!shape[key]) throw new Error(`Unknown editable field: ${key}`);
        return [key, shape[key]];
      }),
    ),
  );
}
/** Creation defaults must not populate fields omitted from an amendment. */
export function drizzlePatch(
  table: Parameters<typeof createUpdateSchema>[0],
  domain: z.ZodObject,
) {
  const shape = Object.fromEntries(
    Object.entries(domain.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.removeDefault() : field,
    ]),
  );
  return drizzleFields(table, Object.keys(domain.shape))
    .extend(shape)
    .partial();
}
export function schemaJSON(schema: z.ZodType): FieldSchema {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "throw",
  }) as FieldSchema;
}
/** App-owned JSON Schema documents use the installed Zod converter, never eval. */
export function documentSchema(schema: Record<string, unknown>) {
  return z.fromJSONSchema(schema);
}
export function changeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((field) => ({
      field,
      before: before[field] ?? null,
      after: after[field],
    }));
}
