import { z } from "zod";

/** Independent, opt-in Onto capability; ordinary graph providers do not promise fences. */
export const ontoSourceFenceContract = {
  id: "outfitter.onto.source-fence",
  version: 1,
} as const;
export const ontoSourceFenceCapability = "source.fence.type-membership.v1";
const id = z.string().min(1).max(128),
  revision = z.number().int().positive(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceFenceProvider = z.strictObject({
  installationId: id,
  contract: z.literal(ontoSourceFenceContract.id),
  version: z.literal(1),
});
const ref = z.strictObject({
  type: z.enum(["graph-type", "graph-node", "graph-edge"]),
  id: z.uuid(),
  revision,
});
export const sourceFenceSubject = z.strictObject({
  installationId: id,
  type: z.literal("graph-node"),
  id: z.uuid(),
  revision,
  digest,
});
export const sourceFenceDefinition = z
  .strictObject({
    version: z.literal(1),
    selection: z.literal("whole-owner-type-membership-v1"),
    sets: z
      .array(
        z.strictObject({
          type: z.enum(["graph-node", "graph-edge"]),
          typeId: z.uuid(),
          includeArchived: z.boolean(),
        }),
      )
      .min(1)
      .max(32),
    records: z
      .array(
        z.strictObject({
          type: z.enum(["graph-node", "graph-edge"]),
          id: z.uuid(),
        }),
      )
      .max(64)
      .default([]),
  })
  .refine(
    (value) =>
      new Set(value.sets.map((set) => `${set.type}:${set.typeId}`)).size ===
      value.sets.length,
    "Duplicate membership sets",
  );
export const defineSourceFenceInput = z.strictObject({
  provider: sourceFenceProvider,
  id,
  version: revision,
  definition: sourceFenceDefinition,
});
export const captureSourceFenceInput = z.strictObject({
  provider: sourceFenceProvider,
  definitionId: id,
  definitionVersion: revision,
  requestKey: id,
  subject: sourceFenceSubject,
});
export const sourceFenceProof = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  provider: sourceFenceProvider,
  scope: z.strictObject({
    owner: z.string().min(1).max(300),
    organizationId: id.nullable(),
  }),
  selection: z.strictObject({
    definitionId: id,
    definitionVersion: revision,
    definitionDigest: digest,
    kind: z.literal("whole-owner-type-membership-v1"),
  }),
  subject: sourceFenceSubject,
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  completeness: z.strictObject({
    complete: z.literal(true),
    errors: z.tuple([]),
  }),
  types: z.array(ref.extend({ type: z.literal("graph-type") })).max(100),
  readSets: z
    .array(
      z.strictObject({
        type: z.enum(["graph-node", "graph-edge"]),
        typeId: z.uuid(),
        includeArchived: z.boolean(),
        records: z.array(z.strictObject({ id: z.uuid(), revision })).max(2000),
      }),
    )
    .min(1)
    .max(32),
  records: z.array(ref).max(100),
  snapshot: z.json(),
  snapshotDigest: digest,
});
export const sourceFenceInput = z.strictObject({
  provider: sourceFenceProvider,
  proofId: z.uuid(),
  subject: sourceFenceSubject,
  idempotencyKey: id,
});
export const sourceFenceStatusInput = z.strictObject({
  provider: sourceFenceProvider,
  idempotencyKey: id,
});
export const sourceFenceResult = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("sealed"),
    proofId: z.uuid(),
    sourceSeal: sourceFenceSubject,
  }),
  z.strictObject({
    status: z.enum(["pending", "conflict"]),
    reason: z.string(),
  }),
]);
export type SourceFenceProof = z.infer<typeof sourceFenceProof>;
export type SourceFenceDefinition = z.infer<typeof sourceFenceDefinition>;
