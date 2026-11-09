// The viewer's reading of one Wiki: the caller's roles, the Wiki's active goals
// and the control commitments the caller owns, in one graph.graphql document
// against the standard Wiki schema (packages/app-sdk/graph/standard-schema.graphql).
// The document starts at the caller's Person (or Agent) node and follows only its
// own edges (holder → assignments → roles → commitments → their parts), so a large
// Wiki never crowds out the caller's records. Traversals take `at`, so ended
// assignments, commitments and obligations are left out by the Wiki. Goals are read
// one hop deep: their pursuers and metrics. A caller without a node in the Wiki gets the goals
// document, which asks for nothing beyond the fields every Wiki serves.
import { isRetired } from "@ai-outfitter/app-sdk/knowledge-graph";

const goals = `goals(first: 100) {
    nodes {
      id slug title body properties
      pursuedBy: edges(types: ["pursues"], direction: INCOMING, at: $at) { from { title } }
      metrics: edges(types: ["measured_by"], direction: OUTGOING, at: $at) { properties to { title } }
    }
    pageInfo { hasNextPage }
  }`;
/** The Wiki's goals alone, for a caller with no node there. It uses only fields every Wiki serves (goals and
 * edges), so it reads a Wiki whose type records predate the standard ontology. Variables: at (now). */
export const viewerGoalsDocument = `query ViewerGoals($at: DateTime!) {
  ${goals}
}`;
/** The caller's roles and commitments as well; it needs the standard RoleAssignment and ControlCommitment
 * relators. Variables: holder (the caller's node ID), at (now). */
export const viewerWikiDocument = `query ViewerWiki($holder: ID!, $at: DateTime!) {
  ${goals}
  me: node(id: $holder) {
    id
    ...Owned
    held: edges(types: ["assigned_to"], direction: INCOMING, at: $at) {
      from { ... on RoleAssignment { validFrom role { id slug title ...Owned } } }
    }
  }
}
fragment Owned on Node {
  ... on Person { owns: commitmentOwnerIncoming(at: $at) { ...Commitment } }
  ... on Role { owns: commitmentOwnerIncoming(at: $at) { ...Commitment } }
}
fragment Commitment on ControlCommitment {
  id slug properties control { title } subject { title }
  obligations: obligationCommitmentIncoming(at: $at) { properties }
}`;

type Properties = Record<string, unknown> | null;
type Titled = { title: string } | null;
type Slugged = { id: string; slug?: string | null };
type Commitment = Slugged & { properties: Properties; control: Titled; subject: Titled; obligations: { properties: Properties }[] };
type Owner = { id: string; owns?: Commitment[] };
/** What viewerWikiDocument answers. */
export type ViewerWikiData = {
  goals: { nodes: (Slugged & { title: string; body: string | null; properties: Properties; pursuedBy: { from: Titled }[]; metrics: { properties: Properties; to: Titled }[] })[]; pageInfo: { hasNextPage: boolean } };
  me?: (Owner & { held: { from: { validFrom?: string | null; role?: (Owner & Slugged & { title: string }) | null } | null }[] }) | null;
};

/** `slug` is the record's address in its Wiki (what to show people and look it up by); `id` is for writes. */
export type ViewerRole = { id: string; slug: string | null; title: string; validFrom: string | null };
export type ViewerGoal = { id: string; slug: string | null; title: string; pursuedBy: string[]; metrics: { title: string; status: string | null }[] };
export type ViewerCommitment = { id: string; slug: string | null; control: string | null; subject: string | null; state: string | null; openObligations: number };
export type WikiView = { roles: ViewerRole[]; goals: ViewerGoal[]; commitments: ViewerCommitment[] };

/** Nested lists per goal are capped so one goal never takes the whole budget. */
const NESTED = 10;
const text = (value: unknown) => (typeof value === "string" ? value : null);
/** An obligation is open until its state says otherwise (the seeds name no closed states yet). */
const openState = (state: unknown) => state === undefined || state === null || state === "" || state === "open";

/** The viewer's reading of one Wiki's answer to viewerWikiDocument. */
export function wikiView(data: ViewerWikiData): WikiView {
  const assignments = (data.me?.held ?? []).flatMap(edge => (edge.from?.role ? [{ role: edge.from.role, validFrom: edge.from.validFrom ?? null }] : []));
  const roles = assignments.map(({ role, validFrom }) => ({ id: role.id, slug: role.slug ?? null, title: role.title || role.id, validFrom })).sort((a, b) => a.title.localeCompare(b.title));
  const goals = data.goals.nodes.filter(goal => !isRetired(goal)).map(goal => ({
    id: goal.id, slug: goal.slug ?? null, title: goal.title || goal.id,
    pursuedBy: goal.pursuedBy.flatMap(edge => (edge.from ? [edge.from.title] : [])).slice(0, NESTED),
    metrics: goal.metrics.flatMap(edge => (edge.to ? [{ title: edge.to.title, status: text(edge.properties?.status) }] : [])).slice(0, NESTED),
  })).sort((a, b) => a.title.localeCompare(b.title));
  const owned = new Map<string, Commitment>();
  for (const owner of [data.me, ...assignments.map(row => row.role)]) for (const row of owner?.owns ?? []) owned.set(row.id, row);
  const commitments = [...owned.values()].filter(row => row.properties?.state !== "ended").map(row => ({
    id: row.id, slug: row.slug ?? null, control: row.control?.title ?? null, subject: row.subject?.title ?? null, state: text(row.properties?.state),
    openObligations: row.obligations.filter(item => openState(item.properties?.state)).length,
  })).sort((a, b) => String(a.control).localeCompare(String(b.control)));
  return { roles, goals, commitments };
}
