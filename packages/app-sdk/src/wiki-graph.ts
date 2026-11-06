import { z } from "zod";

/** Read the active Wiki snapshot; bounded selection uses knowledge-graph.render. */
export const wikiGraphReadInput = z.strictObject({
  includeArchivedTypes: z.boolean().optional(), includeArchivedEdges: z.boolean().optional(),
});
// Read records are not write inputs: preserve legacy values without defaults or transforms.
const record = z.object({ id: z.string(), revision: z.number().int().positive() }).catchall(z.json());
const node = record.extend({ typeId: z.string(), title: z.string() });
export const wikiGraphReadResult = z.object({
  version: z.literal(1),
  installationId: z.string(),
  types: z.array(record.extend({ name: z.string(), category: z.enum(["node", "edge"]) })),
  nodes: z.array(node),
  edges: z.array(node.extend({ fromId: z.string(), toId: z.string() })),
  selection: z.object({ rootId: z.uuid(), lensId: z.uuid(), lensRevision: z.number().int().positive() }).nullable(),
  truncated: z.boolean(),
  missingTypes: z.array(z.string()),
});
export type WikiGraphSnapshot = z.infer<typeof wikiGraphReadResult>;
