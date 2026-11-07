import { z } from "zod";

/** Onto's portable document contract. Providers own the meaning of config;
 * adapters must validate supported configurations before dispatching reads. */
const id = z.string().min(1).max(128);
const version = z.number().int().positive();
export const documentDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const documentProviderBinding = z.strictObject({
  provider: id,
  config: id,
});
/** Policy/event configuration names are short identifiers; serialized source
 * configurations have their own bounded JSON storage envelope. */
export const documentSerializedSourceBinding = z.strictObject({
  provider: id,
  config: z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).length <= 131072,
      "Serialized source config exceeds 128 KiB",
    ),
});
export const documentSource = z.strictObject({
  provider: id,
  config: z
    .record(z.string(), z.json())
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).length <= 131072,
      "Source config exceeds 128 KiB",
    ),
});
export const documentSection = z.strictObject({
  title: z.string().min(1).max(200),
  provider: id,
  pointer: z
    .string()
    .max(512)
    .refine(
      (pointer) => pointer === "" || /^(?:\/(?:[^~]|~[01])*)+$/.test(pointer),
    ),
  required: z.boolean(),
});
export const documentContract = z.strictObject({
  version: z.literal(1),
  identity: id,
  inputSchema: z.record(z.string(), z.json()),
  outputSchema: z.record(z.string(), z.json()),
  params: z.record(z.string(), z.json()),
  period: z
    .strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })
    .refine((period) => Date.parse(period.start) < Date.parse(period.end))
    .optional(),
  measures: z.array(id).max(100).optional(),
  rendering: z.strictObject({
    mode: z.enum(["template", "agent", "combined"]),
    template: z.enum([
      "evidence",
      "business-review",
      "roadmap",
      "feature-issue",
      "bug-issue",
    ]),
    title: z.string().min(1).max(200).optional(),
    sections: z.array(documentSection).max(32).optional(),
  }),
  refresh: z.enum(["live", "manual", "schedule"]),
  requirements: z.strictObject({
    evidence: z.boolean(),
    seal: z.boolean(),
    export: z.boolean(),
  }),
});
export const documentDefinition = z.strictObject({
  retention: z.literal("owner-retained").default("owner-retained"),
  sources: z.array(documentSource).min(1).max(8),
  policy: documentProviderBinding.extend({ required: z.boolean() }).optional(),
  eventConsumer: documentProviderBinding.optional(),
  contract: documentContract.optional(),
  metadata: z
    .strictObject({
      identity: id,
      schema: id,
      renderer: id,
      refresh: id,
      provenance: id,
    })
    .optional(),
});
export type DocumentContract = z.infer<typeof documentContract>;
export type DocumentSection = z.infer<typeof documentSection>;
export type DocumentDefinition = z.input<typeof documentDefinition>;
export type DocumentProviderBinding = z.infer<typeof documentProviderBinding>;
/** Persistence keeps canonical serialized provider configuration; wire inputs keep JSON objects. */
export type SerializedDocumentSourceBinding = z.infer<
  typeof documentSerializedSourceBinding
>;
export type StoredDocumentDefinition = Omit<DocumentDefinition, "sources"> & {
  sources: SerializedDocumentSourceBinding[];
};

export const documentIdInput = z.strictObject({ id });
export const documentRevisionInput = documentIdInput.extend({
  revision: version,
});
export const documentDefineInput = z.strictObject({
  id,
  version,
  definition: documentDefinition,
});
export const documentCreateInput = z.strictObject({
  id,
  definitionId: id,
  version,
});
export const documentGenerateInput = documentIdInput.extend({ jobId: id });
export const documentSealInput = documentRevisionInput.extend({
  digest: documentDigest,
});
export const documentPolicyInput = documentRevisionInput.extend({ action: id });
export const documentCapture = z.strictObject({
  complete: z.boolean(),
  errors: z.array(z.string()),
  sources: z.array(
    documentSerializedSourceBinding.extend({
      provenance: z.json(),
      snapshot: z.json(),
      observedAt: z.iso.datetime().optional(),
    }),
  ),
});
export const documentRevision = z.strictObject({
  revision: version,
  digest: documentDigest,
  payload: z.json(),
  capture: documentCapture,
  complete: z.boolean(),
  definitionId: id,
  definitionVersion: version,
});
export const documentJob = z.strictObject({
  id,
  documentId: id,
  state: z.enum([
    "queued",
    "leased",
    "retry",
    "failed",
    "complete",
    "superseded",
  ]),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  baseRevision: z.number().int().nonnegative(),
});
/** The host policy protocol is opaque here; a receipt never grants authority. */
export const documentPolicyResponse = z.strictObject({
  decision: z.enum(["allow", "deny", "require-review", "unavailable"]),
  binding: z.record(z.string(), z.json()).optional(),
  detail: z.json().optional(),
});
export type DocumentCapture = z.infer<typeof documentCapture>;
export type DocumentRevision = z.infer<typeof documentRevision>;
export type DocumentJob = z.infer<typeof documentJob>;
export type DocumentPolicyResponse = z.infer<typeof documentPolicyResponse>;

export const documentGenerationReceipt = z.strictObject({
  queued: z.literal(true),
  jobId: id,
  runId: id.optional(),
  dispatch: z.literal("pending").optional(),
  message: z.string().max(2000).optional(),
});
/** Older retry handlers returned only queued; retain that receipt compatibility. */
export const documentRetryReceipt = documentGenerationReceipt.extend({
  jobId: id.optional(),
});

/** One public registry keeps client validation, dispatch names and read intent aligned. */
export const documentOperations = {
  define: {
    action: "document.define",
    readOnly: false,
    input: documentDefineInput,
    output: z.strictObject({ saved: z.literal(true) }),
  },
  create: {
    action: "document.create",
    readOnly: false,
    input: documentCreateInput,
    output: z.strictObject({ created: z.literal(true) }),
  },
  live: {
    action: "document.live",
    readOnly: true,
    input: documentIdInput,
    output: documentCapture,
  },
  generate: {
    action: "document.generate",
    readOnly: false,
    input: documentGenerateInput,
    output: documentGenerationReceipt,
  },
  revision: {
    action: "document.revision",
    readOnly: true,
    input: documentRevisionInput,
    output: documentRevision,
  },
  job: {
    action: "document.job",
    readOnly: true,
    input: documentIdInput,
    output: documentJob,
  },
  retry: {
    action: "document.retry",
    readOnly: false,
    input: documentIdInput,
    output: documentRetryReceipt,
  },
  seal: {
    action: "document.seal",
    readOnly: false,
    input: documentSealInput,
    output: z.strictObject({
      sealed: z.literal(true),
      revision: version,
      digest: documentDigest,
      approval: z.literal("not_requested"),
    }),
  },
  policy: {
    action: "document.policy",
    readOnly: true,
    input: documentPolicyInput,
    output: documentPolicyResponse,
  },
} as const;
export type DocumentOperation = keyof typeof documentOperations;
export type DocumentOperationInput<Name extends DocumentOperation> = z.input<
  (typeof documentOperations)[Name]["input"]
>;
export type DocumentOperationOutput<Name extends DocumentOperation> = z.output<
  (typeof documentOperations)[Name]["output"]
>;
