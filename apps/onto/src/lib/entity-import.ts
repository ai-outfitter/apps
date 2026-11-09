import { entityRef } from "@ai-outfitter/app-sdk/entities";
import { z } from "zod";
import { edgeInput, nodeInput } from "./graph";

export const entityImportEdge = edgeInput.extend({ id: z.uuid() });
export const EDGE_IMPORT_LIMIT = 200;

// Deliberately excludes app references, connector identity, private data and audit fields.
export const entityImport = z.strictObject({
  format: z.literal("outfitter-graph-entities-v1"),
  nodes: z.array(nodeInput.extend({ id: z.uuid(), slug: nodeInput.shape.slug.unwrap() })).max(100),
  edges: z.array(entityImportEdge).max(EDGE_IMPORT_LIMIT).default([]),
}).superRefine((input, ctx) => {
  if (new Set(input.edges.map((edge) => edge.id)).size !== input.edges.length)
    ctx.addIssue({ code: "custom", message: "Duplicate edge ID" });
  for (const key of ["id", "slug"] as const)
    if (new Set(input.nodes.map((n) => n[key])).size !== input.nodes.length)
      ctx.addIssue({ code: "custom", message: `Duplicate entity ${key}` });
});

/** Seed project declarations are resolved to canonical Planning records by the host. */
export const seedDocument = entityImport.safeExtend({
  projects: z.array(nodeInput.extend({ id: z.uuid(), source: entityRef.optional() })).max(100).default([]),
});
