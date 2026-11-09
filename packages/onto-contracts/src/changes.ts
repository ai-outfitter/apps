import { z } from "zod";
const kind = z.enum(["graph-type", "graph-node", "graph-edge"]);
const operation = z.strictObject({
  ref: z.string().regex(/^\$[a-z][a-z0-9_-]{0,63}$/i),
  type: kind,
  attributes: z.record(z.string(), z.json()),
});
export const graphReadSetEndpoint = z.strictObject({
  direction: z.enum(["outgoing", "incoming"]),
  nodeId: z.uuid(),
});
export const graphChangeInput = z.strictObject({
  requestKey: z.string().min(1).max(128),
  preconditions: z
    .array(
      z.strictObject({
        type: kind,
        id: z.uuid(),
        revision: z.number().int().positive(),
      }),
    )
    .max(100)
    .optional(),
  readSets: z
    .array(
      z
        .strictObject({
          type: z.enum(["graph-node", "graph-edge"]),
          typeId: z.uuid(),
          includeArchived: z.boolean().optional(),
          endpoint: graphReadSetEndpoint.optional(),
          records: z
            .array(
              z.strictObject({
                id: z.uuid(),
                revision: z.number().int().positive(),
              }),
            )
            .max(2000),
        })
        .refine(
          (set) => !set.endpoint || set.type === "graph-edge",
          "Endpoint selectors require edge sets",
        ),
    )
    .max(32)
    .optional(),
  operations: z
    .array(
      z.discriminatedUnion("operation", [
        operation.extend({ operation: z.literal("create") }),
        operation.extend({
          operation: z.literal("update"),
          /** A type name, node slug or edge `type:from:to`; a record UUID also works. */
          id: z.string().min(1).max(300),
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
