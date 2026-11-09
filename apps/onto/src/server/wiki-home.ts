import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { core, type Graph } from "../lib/graph";

/** A home selects existing records in this installation; it never creates a charter or grants access. */
export function wikiHome(graph: Graph, who: Pick<AppIdentity, "organizationId" | "installationId">): NonNullable<Graph["home"]> {
  if (!who.organizationId) return {};
  const organizations = graph.nodes.filter(node => !node.archived && node.typeId === core.organization);
  const bindings = organizations.filter(node => node.properties.organization_id === who.organizationId);
  const settingsType = graph.types.find(type => !type.archived && type.name === "GovernanceHomeSettings");
  const selected = new Set<string>();
  for (const node of graph.nodes.filter(node => !node.archived && node.typeId === settingsType?.id)) {
    try {
      const settings = JSON.parse(node.body);
      const ref = settings.organization_root;
      if (settings.schema_version === 1 && ref?.installationId === who.installationId && ref.type === "graph-node" && organizations.some(org => org.id === ref.id)) selected.add(ref.id);
    } catch { /* Invalid settings cannot select the home. */ }
  }
  if (selected.size > 1 || (!selected.size && bindings.length !== 1)) return {};
  const organizationId = selected.size ? [...selected][0] : bindings[0].id;
  const charterType = graph.types.find(type => !type.archived && type.name === "BoardCharter");
  const charters = graph.nodes.filter(node => {
    if (node.archived || node.typeId !== charterType?.id) return false;
    try {
      const charter = JSON.parse(node.body);
      return charter.organization_id === organizationId && charter.status === "adopted";
    } catch { return false; }
  });
  return { organizationId, ...(charters.length === 1 ? { charterId: charters[0].id } : {}) };
}
