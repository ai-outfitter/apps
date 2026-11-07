import { z } from "zod";
import { evidenceList } from "@ai-outfitter/connector-core/evidence";
import { ontologyMeasures } from "./ontology-measures";
export * from "./ontology-measures";
/** The bootstrap stops here: definitions are records, not recursively defined definitions. */
export const propertyDefinition = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().min(1).max(2000),
  required: z.boolean().default(false),
});
const slotName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const endpointTypes = z.strictObject({
  from: z.array(z.uuid()).min(1).max(200),
  to: z.array(z.uuid()).min(1).max(200),
});
const participationSlot = z.strictObject({
  name: slotName,
  edgeTypeId: z.uuid(),
  participantTypes: z.array(z.uuid()).min(1).max(200),
  min: z.number().int().nonnegative().max(1000),
  max: z.number().int().nonnegative().max(1000).nullable(),
});
/** Version 2 extends the canonical contract; version 1 remains readable. */
export const ontologyContract = z.discriminatedUnion("version", [
  z.strictObject({
    version: z.literal(1),
    endpoints: endpointTypes.optional(),
  }),
  z.strictObject({
    version: z.literal(2),
    endpoints: endpointTypes.optional(),
    stereotype: z.enum(["kind", "relator", "event", "assertion"]).optional(),
    immutable: z.boolean().optional().describe("Records of this type are append-only after creation."),
    symmetric: z.boolean().optional(),
    validity: z.literal("interval").optional(),
    measures: ontologyMeasures.optional(),
    participation: z
      .strictObject({
        slots: z.array(participationSlot).min(1).max(16),
        distinct: z.array(z.array(slotName).min(1).max(16)).max(16).optional(),
        uniqueBy: z.array(slotName).min(1).max(16).optional(),
      })
      .optional(),
    projection: z
      .strictObject({
        relatorTypeId: z.uuid(),
        fromSlot: slotName,
        toSlot: slotName,
        symmetric: z.boolean(),
      })
      .optional(),
  }),
]);
export type OntologyContract = z.infer<typeof ontologyContract>;
export type OntologyV2 = Extract<OntologyContract, { version: 2 }>;
export const validityInterval = z.strictObject({
  from: z.iso.datetime({ offset: true }).nullable(),
  to: z.iso.datetime({ offset: true }).nullable(),
});
export type ValidityInterval = z.infer<typeof validityInterval>;

/** Assertion payloads describe claims, never authentication or confirmed truth. */
export const assertionBody = z.strictObject({
  schemaVersion: z.literal(1),
  subject: z.strictObject({
    type: z.enum(["graph-node", "graph-edge"]),
    id: z.uuid(),
    revision: z.number().int().positive(),
  }),
  stance: z.enum(["supports", "refutes"]),
  status: z.enum(["proposed", "withdrawn"]),
  uncertainty: z.strictObject({
    reason: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1).optional(),
  }),
  evidence: evidenceList,
  provenance: z.strictObject({
    method: z.enum(["manual", "inference", "import"]),
    generatedAt: z.iso.datetime({ offset: true }),
    agentId: z.string().min(1).max(256).optional(),
    runId: z.string().min(1).max(256).optional(),
  }),
});
export type WikiAssertion = z.infer<typeof assertionBody>;

export const typeInput = z.strictObject({
  ontology: ontologyContract.optional(),
  id: z
    .uuid()
    .optional()
    .describe("Optional stable ID at creation; immutable afterwards."),
  jsonSchema: z.record(z.string(), z.json()).optional().meta({
    description:
      "Optional JSON Schema for the node body. Includes field descriptions for document display and agent responses.",
  }),
  category: z.enum(["node", "edge"]),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(20000),
  properties: z.array(propertyDefinition).max(32).default([]),
  archived: z.boolean().default(false),
});
export const properties = z
  .record(
    z.string().max(48),
    z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]),
  )
  .default({});
export const nodeBodyLimit = 65_536;
export const nodeInput = z.strictObject({
  validity: validityInterval.nullable().optional(),
  id: z
    .uuid()
    .optional()
    .describe("Optional stable ID at creation; immutable afterwards."),
  typeId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  summary: z.string().max(280).default(""),
  body: z
    .string()
    .max(nodeBodyLimit)
    .default("")
    .describe(
      "Markdown, or a serialized JSON document when the node type supplies jsonSchema. Validate structured values against that type schema before writing.",
    ),
  website: z
    .union([z.literal(""), z.url({ protocol: /^https?$/ })])
    .nullable()
    .default(null),
  properties,
  archived: z.boolean().default(false),
});
export const edgeInput = z.strictObject({
  validity: validityInterval.nullable().optional(),
  id: z
    .uuid()
    .optional()
    .describe("Optional stable ID at creation; immutable afterwards."),
  typeId: z.uuid(),
  fromId: z.uuid(),
  toId: z.uuid(),
  title: z.string().max(120).default(""),
  body: z.string().max(20000).default(""),
  properties,
  archived: z.boolean().default(false),
});

export const wikiGraph = z.strictObject({
  types: z.array(typeInput.extend({ id: z.uuid() })).max(200),
  nodes: z.array(nodeInput.extend({ id: z.uuid() })).max(2000),
  edges: z.array(edgeInput.extend({ id: z.uuid() })).max(10000),
});
export type WikiGraph = z.infer<typeof wikiGraph>;


export * from "./wiki-graph";
export * from "./wiki-proposals";
export * from "./changes";
export * from "./batches";
export const ontoContract = { id: "outfitter.onto", version: 1 } as const;
