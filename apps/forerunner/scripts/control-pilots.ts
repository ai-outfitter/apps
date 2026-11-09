import { responseMeasurement, quarterlyMeasurement, responseDefinition, quarterlyDefinition } from "./control-measurements";
import { wikiGraph, type WikiGraph } from "@ai-outfitter/app-sdk/graph-contracts";

export const pilotId = (n: number) => `86cd3b21-71e2-5dfa-9bd0-${String(n).padStart(12, "0")}`;
const core = {
  person: "71000000-0000-4000-8000-000000000005",
  goal: "71000000-0000-4000-8000-000000000010",
  product: "71000000-0000-4000-8000-000000000015",
};
type Node = WikiGraph["nodes"][number];
const node = (id: number, typeId: string, title: string, body: string, properties = {}): Node => ({
  id: pilotId(id), typeId, title, slug: `control-pilot-${id}`, body, properties, summary:"", website:null, archived:false,
});
const edge = (id: number, type: number, fromId: string, toId: string) => ({
  id: pilotId(id), typeId: pilotId(type), fromId, toId,
  body: "Forerunner control pilot seed. No scheduler, connector or notification is activated.",
});

/** Owner IDs are supplied explicitly from the destination seed, never guessed
 * from email or copied between personal and organization installations. */
export function personalControlPilot(owner: {id:string; name:string}, friend: {id:string; name:string}) {
  return wikiGraph.parse({ types: [], nodes: [
    node(201, pilotId(1), `Friendship: ${owner.name} and ${friend.name}`,
      "Personal friendship represented at the user's explicit request. Calendar co-attendance alone is not evidence of friendship. No start date has been invented."),
    node(202, core.goal, `See ${friend.name} once each quarter`,
      "Personal goal: at least one completed interaction per local calendar quarter. Invitations and canceled events do not count. No completion is claimed by this seed."),
    node(203, pilotId(2), "Quarterly contact with a friend — proposed control",
      JSON.stringify(quarterlyDefinition),
      {...quarterlyMeasurement, state:"proposed", policy_version:"1", threshold:1, unit:"confirmed interactions", window:"calendar quarter", timezone:"America/Chicago", success_criterion:"At least one confirmed completed interaction in the quarter"}),
    node(204, pilotId(3), "Quarterly friendship contact — proposed commitment",
      "The person, friendship and versioned control are linked for review. Scheduling, reminders and acceptance are not enabled by this seed.", {state:"proposed"}),
  ], edges: [
    edge(211,11,pilotId(201),owner.id), edge(212,11,pilotId(201),friend.id),
    edge(213,13,pilotId(204),owner.id), edge(214,14,pilotId(204),pilotId(203)),
    edge(215,15,pilotId(204),pilotId(201)), edge(216,18,pilotId(203),pilotId(202)),
  ] });
}

export function organizationControlPilot(ownerId: string, organizationId: string) {
  return wikiGraph.parse({ types: [], nodes: [
    node(301, core.product, "PostHog", "Source service for the proposed issue-response pilot. This record does not imply a connected account or active monitoring."),
    node(302, core.goal, "Address qualifying PostHog issues within eight hours",
      "Proposed Outfitter service-response goal. Qualifying scope, response evidence and accountable ownership require review before operation."),
    node(303, pilotId(2), "PostHog eight-hour issue response — proposed control",
      JSON.stringify(responseDefinition),
      {...responseMeasurement, state:"proposed", policy_version:"1", threshold:8, unit:"elapsed hours", window:"per qualifying issue episode", timezone:"UTC", success_criterion:"triaged_with_plan: diagnosis, accountable owner and actionable next step"}),
    node(304, pilotId(3), "Outfitter PostHog response — proposed commitment",
      "Proposed responsibility for the Outfitter-scoped control. The named owner is a pilot routing choice, not evidence of accepted duty. No notification or workflow is enabled.", {state:"proposed"}),
    node(305, pilotId(5), "Example PostHog issue episode — synthetic",
      "Synthetic fixture only. This is not an observed production exception. A real episode requires a selected source project, issue ID and opening/reopening evidence.",
      {source:"PostHog", source_id:"synthetic-pilot-episode-1", synthetic:true}),
    node(306, pilotId(4), "Example eight-hour response obligation — synthetic",
      "Synthetic fixture: opened at 09:00 UTC, due at 17:00 UTC on 2026-10-29. No compliance result is asserted; this record demonstrates the issue-to-commitment relator only.",
      {state:"example", triggered_at:"2026-10-29T09:00:00Z", due_at:"2026-10-29T17:00:00Z", synthetic:true}),
  ], edges: [
    edge(311,13,pilotId(304),ownerId), edge(312,14,pilotId(304),pilotId(303)),
    edge(313,15,pilotId(304),organizationId), edge(314,18,pilotId(303),pilotId(302)),
    edge(315,16,pilotId(306),pilotId(304)), edge(316,17,pilotId(306),pilotId(305)),
    edge(317,19,pilotId(305),pilotId(301)), edge(318,20,pilotId(303),pilotId(301)),
  ] });
}

/** Add only: matching identities retain authored content; conflicting identities
 * fail before either destination is written. */
export function mergePilot(seed: WikiGraph, additions: WikiGraph): WikiGraph {
  checkTypeIdentities(seed.types, additions.types);
  for (const added of additions.nodes) {
    const existing = seed.nodes.find(n => n.id === added.id);
    if (existing && existing.typeId !== added.typeId) throw new Error(`Conflicting node identity: ${added.id}`);
    if (added.slug && seed.nodes.some(n => n.slug === added.slug && n.id !== added.id))
      throw new Error(`Conflicting node slug: ${added.slug}`);
  }
  for (const added of additions.edges) {
    const existing = seed.edges.find(e => e.id === added.id);
    if (existing && ["typeId", "fromId", "toId"].some(k => existing[k as keyof typeof existing] !== added[k as keyof typeof added]))
      throw new Error(`Conflicting relationship identity: ${added.id}`);
  }
  const append = <T extends {id?:string}>(before: T[], extra: T[]) => {
    const ids = new Set(before.map(r => r.id));
    return [...before,...extra.filter(r => !ids.has(r.id))];
  };
  return {types:append(seed.types, additions.types),nodes:append(seed.nodes,additions.nodes),edges:append(seed.edges,additions.edges)};
}

export const personTypeId = core.person;

function checkTypeIdentities(existingTypes: WikiGraph["types"], types: WikiGraph["types"]) {
  for (const type of types) {
    const existing = existingTypes.find(t => t.id === type.id);
    if (existing && (existing.name !== type.name || existing.category !== type.category))
      throw new Error(`Conflicting type identity: ${type.id}`);
    const collision = existingTypes.find(t => t.name === type.name && t.id !== type.id);
    if (collision) throw new Error(`Type ${type.name} already has another identity; reconcile it before seeding`);
  }
}
