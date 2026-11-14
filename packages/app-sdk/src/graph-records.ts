import type { z } from "zod";
import type { wikiGraphReadResult } from "./graph-contracts/index";
import { entityRef, type EntityRecord } from "./entities";

/** Convert a graph snapshot to canonical entity records without fetching or formatting. */
export function wikiGraphRecords(snapshot: Pick<z.infer<typeof wikiGraphReadResult>, "installationId" | "types" | "nodes" | "edges">, includeArchivedTypes = false) {
  function records(type: string, rows: Array<typeof snapshot.nodes[number] | typeof snapshot.types[number]>): EntityRecord[] {
    return rows.map(row => {
      const { id, revision, createdBy, updatedBy, createdAt, updatedAt, ...attributes } = row;
      return {
        ref: { installationId: snapshot.installationId, type, id }, revision,
        title: String(row.title ?? row.name ?? id),
        attributes: { id, ...attributes, provenance: { createdBy: createdBy ?? null, updatedBy: updatedBy ?? null, createdAt: createdAt ?? null, updatedAt: updatedAt ?? null } },
        references: row.source ? [entityRef.parse(row.source)] : [],
      };
    });
  }
  return {
    types: records("graph-type", snapshot.types.filter(row => includeArchivedTypes || !row.archived)),
    nodes: records("graph-node", snapshot.nodes),
    edges: records("graph-edge", snapshot.edges),
  };
}
