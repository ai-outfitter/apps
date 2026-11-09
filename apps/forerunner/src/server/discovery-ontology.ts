import { wikiProposalRulesText } from "@ai-outfitter/app-sdk/graph-contracts";
import type { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { OntologyContract } from "@ai-outfitter/app-sdk/graph-contracts";

type Graph = Awaited<ReturnType<typeof readWikiGraph>>;
export type OntologyType = { id: string; name: string; definition: string };
export type OntologyRelation = OntologyType & { from: string[]; to: string[] };
export type DiscoveryOntology = { entities: OntologyType[]; relationships: OntologyRelation[] };
// Initial discovery focuses on durable context; calendar participation stays source evidence.
const excluded = new Set(["Goal", "Question", "Activity", "Entity", "participates_in", "participant", "interacts_with", "customer_of"]);

/** Wiki type prose contains an ontological introduction followed by agent guidance.
 * Only the introduction supplies discovery definitions. */
export function ontologyDefinition(body: string) {
  const introduction = body.split(/^##?\s+(?:For agents|Agent guidance|Behavior|Usage|Examples?)\b/im)[0];
  return introduction.split(/\n\s*\n/).map(p => p.replace(/^#+[^\n]*(?:\n|$)/gm, "").trim()).filter(Boolean)
    .join(" ").split(/(?<=[.!?])\s+/).filter(s => !/^(?:Do not|Don’t|Never|Always|Use |Read |Keep |Record |Preserve |Treat |Connect |Separate |State |Ask |Prefer |Avoid |Unknown |This .*grants? |No .*grant)/i.test(s))
    .slice(0,1).join(" ").replace(/\s+/g, " ").trim();
}
function namesIn(text: string, types: OntologyType[]) {
  const found: { name: string; start: number; end: number }[] = [];
  for (const type of types) {
    const phrase = type.name.replace(/([a-z])([A-Z])/g, "$1 $2");
    const escaped = [type.name, phrase].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = new RegExp(`\\b(?:${escaped.join("|")})s?\\b`, "gi");
    for (const match of text.matchAll(regex)) found.push({ name: type.name, start: match.index, end: match.index + match[0].length });
  }
  return found.sort((a,b) => a.start-b.start);
}
/** Directions are derived from explicit live Domain/Range lines when present,
 * then the live source/target sentence or subject/predicate/object introduction.
 * Ambiguous directions remain unavailable rather than inventing endpoint types. */
function endpoints(body: string, definition: string, types: OntologyType[]) {
  const domain = body.match(/^(?:From|Domain|Source types?):\s*(.+)$/im)?.[1];
  const range = body.match(/^(?:To|Range|Target types?):\s*(.+)$/im)?.[1];
  const resolve = (text: string) => /^(?:\*|any (?:entity|node)(?: type)?)$/i.test(text.trim()) ? types.map(t => t.name) : [...new Set(namesIn(text, types).map(t => t.name))];
  if (domain && range) return { from: resolve(domain), to: resolve(range) };
  const directed = definition.match(/\bsource\b(.*?)\btarget\b([^.!?]*)/i);
  if (directed) return { from: resolve(directed[1]), to: resolve(directed[2]) };
  const mentions = namesIn(definition.split(/(?<=[.!?])\s/)[0], types);
  if (mentions.length < 2) return { from: [], to: [] };
  let split = 1;
  while (split < mentions.length && /^(?:\s|,|or\b|and\b|an?\b|the\b)+$/i.test(definition.slice(mentions[split-1].end, mentions[split].start))) split++;
  return { from: [...new Set(mentions.slice(0,split).map(t => t.name))], to: [...new Set(mentions.slice(split).map(t => t.name))] };
}
export function discoveryOntology(graph: Graph): DiscoveryOntology {
  const active = graph.types.filter(t => !t.attributes.archived).map(t => ({
    id: t.ref.id, name: String(t.attributes.name), category: t.attributes.category,
    structuredBody: !!t.attributes.jsonSchema,
    ontology: t.attributes.ontology as OntologyContract | undefined,
    body: String(t.attributes.body ?? ""), definition: ontologyDefinition(String(t.attributes.body ?? "")),
  }));
  const allEntities = active.filter(t => t.category === "node");
  const flatEntities = allEntities.filter(t => !t.structuredBody && !["relator", "assertion"].includes(t.ontology?.version === 2 ? t.ontology.stereotype ?? "" : ""));
  const entities = flatEntities.filter(t => !excluded.has(t.name)).map(({ id,name,definition }) => ({ id,name,definition }));
  const allowed = new Set(entities.map(t => t.name));
  const relationships = active.filter(t => t.category === "edge" && !(t.ontology?.version === 2 && t.ontology.projection) && !excluded.has(t.name)).flatMap(t => {
    // Structured contracts are authoritative, including when an endpoint is no
    // longer active. Only legacy types without a contract use prose inference.
    const contract = t.ontology?.endpoints;
    const byId = new Map(allEntities.map(type => [type.id, type.name]));
    const ids = (side: "any" | string[]) => side === "any" ? allEntities.map(type => type.id) : side;
    if (contract && (!ids(contract.from).length || !ids(contract.to).length ||
      [...ids(contract.from), ...ids(contract.to)].some(id => !byId.has(id)))) return [];
    const direction = contract
      ? { from: ids(contract.from).map(id => byId.get(id) ?? ""), to: ids(contract.to).map(id => byId.get(id) ?? "") }
      : endpoints(t.body, t.definition, allEntities);
    if (!direction.from.some(n => allowed.has(n))) return [];
    if (!direction.to.some(n => allowed.has(n))) return [];
    return [{ id:t.id, name:t.name, definition:t.definition, from:direction.from.filter(n => allowed.has(n)), to:direction.to.filter(n => allowed.has(n)) }];
  });
  if (!entities.length) throw new Response("Wiki has no active discovery entity types", { status:409 });
  return { entities, relationships };
}
export function discoveryPrompt(user: { name: string; email: string }, ontology: DiscoveryOntology) {
  const singleLine = (text: string) => text.replace(/[\r\n]/g," ");
  return `# Operating user\nName: ${singleLine(user.name)}\nEmail: ${singleLine(user.email)}\n\nBuild a knowledge graph describing this user's personal and professional context from the selected sources.\n\n# Wiki ontology\n## Entity types\n${ontology.entities.map(t => `- ${t.name}: ${t.definition}`).join("\n")}\n\n## Relationship types\n${ontology.relationships.map(t => `- ${t.name}: ${t.definition}\n  Direction: ${t.from.join(" | ") || "unspecified"} → ${t.to.join(" | ") || "unspecified"}`).join("\n")}\n\n# Proposal rules\nThe same rules every agent follows when it proposes Wiki records.\n${wikiProposalRulesText}`;
}
