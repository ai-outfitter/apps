import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { edgeInput, nodeInput, typeInput } from "@ai-outfitter/app-sdk/graph-contracts";
import type { z } from "zod";

type Version = { revision: number; createdAt: number; updatedAt: number; createdBy: string | null; updatedBy: string | null };
export type TypeDefinition = z.infer<typeof typeInput> & Version & { id: string; seedVersion: number | null };
export type GraphNode = z.infer<typeof nodeInput> & Version & { id: string; source: { installationId: string; type: string; id: string } | null };
export type GraphEdge = z.infer<typeof edgeInput> & Version & { id: string };
export type Graph = { types: TypeDefinition[]; nodes: GraphNode[]; edges: GraphEdge[]; canEdit: boolean };

/** Planning's read-only view of canonical graph records, including their versions. */
export function productGraph(records: { types: EntityRecord[]; nodes: EntityRecord[]; edges: EntityRecord[] }): Graph {
  const version = (record: EntityRecord): Version => {
    const provenance = record.attributes.provenance as Record<string, unknown> | undefined;
    return { revision: record.revision, createdAt: Number(provenance?.createdAt ?? 0), updatedAt: Number(provenance?.updatedAt ?? 0), createdBy: null, updatedBy: null };
  };
  return {
    canEdit: false,
    types: records.types.map(record => ({ ...typeInput.strip().parse(record.attributes), ...version(record), id: record.ref.id, seedVersion: null })),
    nodes: records.nodes.map(record => ({ ...nodeInput.strip().parse(record.attributes), ...version(record), id: record.ref.id, source: record.references.find(ref => ref.type === "project") ?? null })),
    edges: records.edges.map(record => ({ ...edgeInput.strip().parse(record.attributes), ...version(record), id: record.ref.id })),
  };
}
