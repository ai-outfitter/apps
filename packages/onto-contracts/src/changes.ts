import { z } from "zod";
const kind = z.enum(["graph-type", "graph-node", "graph-edge"]);
const operation = z.strictObject({
  ref: z.string().regex(/^\$[a-z][a-z0-9_-]{0,63}$/i),
  type: kind,
  attributes: z.record(z.string(), z.json()),
});
export const graphChangeInput = z.strictObject({
  requestKey: z.string().min(1).max(128),
  preconditions: z.array(z.strictObject({ type: kind, id: z.uuid(), revision: z.number().int().positive() })).max(100).optional(),
  readSets: z.array(z.strictObject({
    type: z.enum(["graph-node", "graph-edge"]), typeId: z.uuid(), includeArchived: z.boolean().optional(),
    records: z.array(z.strictObject({ id: z.uuid(), revision: z.number().int().positive() })).max(2000),
  })).max(32).optional(),
  operations: z
    .array(
      z.discriminatedUnion("operation", [
        operation.extend({ operation: z.literal("create") }),
        operation.extend({
          operation: z.literal("update"),
          id: z.uuid(),
          revision: z.number().int().positive(),
        }),
      ]),
    )
    .min(1)
    .max(100),
});
export const graphChangeReceipt = z.record(
  z.string(),
  z.strictObject({ id: z.uuid(), revision: z.number().int().positive() }),
);
