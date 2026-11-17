import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { core, type Graph } from "../lib/graph";

/** Installation authority comes only from host dispatch, never graph data or batch input.
 * An optional graph representation supplies context, not ownership or permissions. */
export function reviewOwner(graph: Graph, who: AppIdentity) {
  const owner = who.owner;
  if (!owner?.id || !who.installationId ||
      (owner.kind === "organization" ? who.organizationId !== owner.id : Boolean(who.organizationId)))
    throw new Response("Inconsistent installation owner", { status: 403 });
  const matches = owner.kind === "organization"
    ? graph.nodes.filter(node => !node.archived && node.typeId === core.organization && node.properties.organization_id === owner.id)
    : [];
  const node = matches.length === 1 ? matches[0] : null;
  return {
    kind: owner.kind, id: owner.id, installationId: who.installationId,
    authority: "host-installation" as const,
    graphNode: node ? { id: node.id, title: node.title } : null,
    graphBinding: matches.length > 1 ? "ambiguous" as const : node ? "matched" as const : "absent" as const,
  };
}
