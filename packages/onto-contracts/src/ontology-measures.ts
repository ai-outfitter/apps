import { z } from "zod";

/** Measures name what a consumer may compute over a type's records. The SDK only
 * validates their shape: a formula names the property keys where a record keeps
 * its own definition, and the owning app evaluates it. */
const identifier = z.string().regex(/^[a-z][A-Za-z0-9]{0,47}$/);
const propertyKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const reference = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const where = z.strictObject({ property: propertyKey, equals: z.union([z.string().max(200), z.number(), z.boolean()]) });
export const formulaFieldNames = ["measurement", "calculation", "aggregation", "window", "interval", "threshold", "unit", "source"] as const;
export const measureExpression = z.discriminatedUnion("op", [
  // Without `of`: records of this type. With `of`: a relator slot that targets
  // this type, or an edge type name; `direction` is seen from this type's record.
  z.strictObject({
    op: z.literal("count"), of: reference.optional(),
    direction: z.enum(["incoming", "outgoing"]).optional(), where: where.optional(),
  }),
  z.strictObject({ op: z.enum(["sum", "min", "max"]), property: propertyKey }),
  z.strictObject({ op: z.literal("active"), at: z.literal("now").optional() }),
  z.strictObject({
    op: z.literal("formula"), language: z.string().regex(/^[a-z][a-z0-9]{0,31}-v[0-9]{1,3}$/),
    fields: z.partialRecord(z.enum(formulaFieldNames), propertyKey).refine((fields) => Object.keys(fields).length > 0, "Name at least one formula field."),
  }),
]);
export const ontologyMeasure = z.strictObject({
  name: identifier, title: z.string().min(1).max(120).optional(), expression: measureExpression,
  grain: z.string().min(1).max(200).optional(), unit: z.string().min(1).max(80).optional(),
});
export const ontologyMeasures = z.array(ontologyMeasure).min(1).max(32)
  .refine((measures) => new Set(measures.map((m) => m.name)).size === measures.length, "Measure names must be unique.");
export type OntologyMeasure = z.infer<typeof ontologyMeasure>;
export type MeasureExpression = z.infer<typeof measureExpression>;

/** Declared measures of a type row; unknown or legacy contracts have none. */
export function typeMeasures(type: { ontology?: unknown }): OntologyMeasure[] {
  const ontology = type.ontology as { version?: unknown; measures?: unknown } | undefined;
  if (ontology?.version !== 2 || ontology.measures === undefined) return [];
  const parsed = ontologyMeasures.safeParse(ontology.measures);
  return parsed.success ? parsed.data : [];
}

/** Standard names for business validity. The Wiki stores it in the record's
 * `validity: { from, to }` column (end exclusive); readers expose these names. */
export const validityFields = { from: "validFrom", until: "validUntil" } as const;
export type RecordValidity = { validFrom: string | null; validUntil: string | null };
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
// The column wins when present: a null end there means unbounded, not unknown.
export function recordValidity(record: { validity?: unknown; properties?: unknown }): RecordValidity {
  const column = record.validity;
  if (column && typeof column === "object") {
    const { from, to } = column as { from?: unknown; to?: unknown };
    return { validFrom: text(from), validUntil: text(to) };
  }
  const props = (record.properties && typeof record.properties === "object" ? record.properties : {}) as Record<string, unknown>;
  return {
    validFrom: text(props[validityFields.from]) ?? text(props.valid_from),
    validUntil: text(props[validityFields.until]) ?? text(props.valid_until),
  };
}
