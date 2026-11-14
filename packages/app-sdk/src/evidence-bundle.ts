import { z } from "zod";
import { stableGraphId } from "./graph-client";

/**
 * The graph records that make a test-evidence bundle show in Planning, as
 * Onto change-batch proposals (ChangeBatchChanges `stage` or `amend`).
 *
 * Planning's project Evidence page (`/projects/<id>/evidence`) lists Documents
 * that `documents` the Onto Project referencing the Planning project (or a
 * Release `part_of` it), and draws a screenshot grid from the Demonstrations
 * each Document `includes_record`. A link to a Product alone shows nothing,
 * and without an `includes_record` type there is no grid. Files are uploaded
 * first (Software Foundry `SubmitReleaseEvidence`); steps name their permanent URLs.
 */

/** One captured step: a numbered Demonstration with its screenshot. */
export const evidenceStep = z.strictObject({
  title: z.string().trim().min(1).max(150),
  url: z.url({ protocol: /^https$/ }),
  caption: z.string().trim().max(280).default(""),
});

/** The Demonstration body Onto's artifacts seed validates (strict: no other keys). */
export const demonstrationBody = z.strictObject({
  subject: z.strictObject({ id: z.string().min(1), revision: z.int().positive() }),
  environment: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  media: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
});

export const evidenceBundleInput = z.strictObject({
  /** The target graph's types; looked up by name, since IDs differ between graphs. */
  types: z.array(z.object({ id: z.string(), name: z.string(), category: z.enum(["node", "edge"]) }).loose()),
  /** The bundle Document. Pass `existing: true` when it is already saved or proposed. */
  document: z.strictObject({
    id: z.uuid(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    title: z.string().min(1).max(160),
    summary: z.string().max(280).default(""),
    body: z.string().max(65536).default(""),
    website: z.url().optional(),
    existing: z.boolean().default(false),
  }),
  /** The Onto Project node whose reference is the Planning project. */
  projectNodeId: z.uuid(),
  /** What the demonstration shows: usually the Product or ProductRevision, at its revision. */
  subject: demonstrationBody.shape.subject,
  environment: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  limitations: z.array(z.string().min(1)).min(1),
  steps: z.array(evidenceStep).min(1).max(40),
});
export type EvidenceBundleInput = z.input<typeof evidenceBundleInput>;

export type EvidenceProposal = {
  ref: string;
  type: "graph-type" | "graph-node" | "graph-edge";
  operation: "create";
  attributes: Record<string, unknown>;
};

/** The standard `includes_record` edge type, for a graph that predates the artifacts seed. */
export const includesRecordType = {
  category: "edge",
  name: "includes_record",
  title: "includes record",
  body: "The source evidence bundle Document includes the exact target record revision named by record_revision, in the stated role. Look the type up by name: a graph may hold it under another ID.",
  properties: [
    { name: "record_revision", type: "number", description: "Exact target graph record revision included in this bundle.", required: true },
    { name: "role", type: "string", description: "Subject, story, flow, demonstration, source receipt, criterion, evaluation, definition or project.", required: true },
  ],
} as const;

/** Change-batch proposals for one bundle; stable IDs make a repeat produce the same records. */
export async function evidenceBundleOperations(raw: EvidenceBundleInput): Promise<EvidenceProposal[]> {
  const input = evidenceBundleInput.parse(raw);
  const typeId = (name: string, category: "node" | "edge") =>
    input.types.find((type) => type.name === name && type.category === category)?.id;
  const required = (name: string, category: "node" | "edge") => {
    const id = typeId(name, category);
    if (!id) throw new Error(`The graph has no ${category} type named ${name}; Planning cannot show this bundle.`);
    return id;
  };
  const documentType = required("Document", "node");
  const demonstrationType = required("Demonstration", "node");
  const documentsType = required("documents", "edge");
  const operations: EvidenceProposal[] = [];
  let includesType = typeId("includes_record", "edge");
  if (!includesType) {
    includesType = await stableGraphId("standard-type", "includes_record", input.document.id);
    operations.push({
      ref: "$includes-record-type",
      type: "graph-type",
      operation: "create",
      attributes: {
        id: includesType,
        ...includesRecordType,
        properties: [...includesRecordType.properties],
        ontology: { version: 2, endpoints: { from: [documentType], to: "any" } },
      },
    });
  }
  const { document } = input;
  if (!document.existing)
    operations.push({
      ref: "$evidence-bundle",
      type: "graph-node",
      operation: "create",
      attributes: {
        id: document.id,
        typeId: documentType,
        slug: document.slug,
        title: document.title,
        summary: document.summary,
        body: document.body,
        ...(document.website ? { website: document.website } : {}),
      },
    });
  for (const [index, step] of input.steps.entries()) {
    const n = index + 1;
    const id = await stableGraphId("evidence-step", document.id, n);
    const body = demonstrationBody.parse({
      subject: input.subject,
      environment: input.environment,
      capturedAt: input.capturedAt,
      media: [step.url],
      limitations: input.limitations,
    });
    operations.push(
      {
        ref: `$evidence-step-${n}`,
        type: "graph-node",
        operation: "create",
        attributes: {
          id,
          typeId: demonstrationType,
          slug: `${document.slug.slice(0, 70)}-step-${n}`,
          // Planning sorts Demonstrations by title; the number keeps step order.
          title: `${n}. ${step.title}`,
          summary: step.caption,
          body: JSON.stringify(body),
        },
      },
      {
        ref: `$evidence-includes-step-${n}`,
        type: "graph-edge",
        operation: "create",
        attributes: {
          id: await stableGraphId("evidence-includes", document.id, n),
          typeId: includesType,
          fromId: document.id,
          toId: id,
          properties: { record_revision: 1, role: "demonstration" },
        },
      },
    );
  }
  operations.push({
    ref: "$evidence-documents-project",
    type: "graph-edge",
    operation: "create",
    attributes: {
      id: await stableGraphId("evidence-documents-project", document.id, input.projectNodeId),
      typeId: documentsType,
      fromId: document.id,
      toId: input.projectNodeId,
      properties: {},
    },
  });
  return operations;
}
