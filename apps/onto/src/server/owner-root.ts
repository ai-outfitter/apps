import { eq, sql } from "drizzle-orm";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { userKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { core, type Graph } from "../lib/graph";
import { readGraph } from "./graph";
import { graphNodes } from "./schema";
import { reviewOwner } from "./review-owner";
import { guardedGraphBatch } from "./graph-batch";
import { projectGraphChanges } from "./graph-changes";

type Database = ReturnType<typeof installationDatabase>;
const accountType = "71000000-0000-4000-8000-000000000120";
const accountOf = "71000000-0000-4000-8000-000000000122";

/** Scope is host authority. A personal account is the root until a verified holder
 * exists; guessing that a user is a particular Person or Agent is never necessary. */
export async function rootContext(db: Database, graph: Graph, who: AppIdentity) {
  const owner = reviewOwner(graph, who);
  if (owner.kind === "organization") return owner;
  const keys = new Set((await db.select({ id: graphNodes.id }).from(graphNodes)
    .where(eq(graphNodes.externalKey, userKey(owner.id)))).map(row => row.id));
  const accounts = graph.nodes.filter(n => keys.has(n.id));
  const account = accounts.length === 1 && !accounts[0].archived && accounts[0].typeId === accountType ? accounts[0] : null;
  if (!account) return { ...owner, graphNode: null, graphBinding: accounts.length ? "conflicting" : "absent" };
  const links = graph.edges.filter(e => !e.archived && e.typeId === accountOf && e.fromId === account.id);
  const holderIds = new Set(links.map(e => e.toId));
  const holders = graph.nodes.filter(n => holderIds.has(n.id) && !n.archived && [core.person, core.agent].includes(n.typeId));
  if (holderIds.size > 1 || holders.length !== holderIds.size)
    return { ...owner, graphNode: null, graphBinding: "ambiguous" };
  return { ...owner, graphNode: holders[0] ?? account, graphBinding: "matched" };
}

const address = (graph: Graph, node: { id: string } | null) => {
  const row = node && graph.nodes.find(n => n.id === node.id);
  const type = row && graph.types.find(t => t.id === row.typeId);
  return row && type ? `${type.name}:${row.slug}` : null;
};
export async function ownerRootStatus(db: Database, who: AppIdentity) {
  const graph = await readGraph(db, who);
  const root = await rootContext(db, graph, who);
  return { status: root.graphNode ? "ready" : "blocked", root: address(graph, root.graphNode), binding: root.graphBinding, created: false };
}

/** Repeatable installation bootstrap, also callable explicitly by an editor.
 * Never adopts by name, replaces an archive, changes a holder, or links unrelated data. */
export async function ensureOwnerRoot(db: Database, who: AppIdentity) {
  requireEditor(who);
  for (let attempt = 0; attempt < 3; attempt++) {
    const graph = await readGraph(db, who);
    const root = await rootContext(db, graph, who);
    if (root.graphNode) return { status: "ready", root: address(graph, root.graphNode), binding: "matched", created: false };
    if (root.graphBinding !== "absent") return { status: "blocked", root: null, binding: root.graphBinding, created: false };
    // An archived exact binding is deliberate history, not permission to recreate it.
    if (root.kind === "organization" && graph.nodes.some(n => n.typeId === core.organization && n.properties.organization_id === root.id))
      return { status: "blocked", root: null, binding: "archived", created: false };
    const typeId = root.kind === "organization" ? core.organization : accountType;
    const type = graph.types.find(t => t.id === typeId && !t.archived);
    if (!type) return { status: "blocked", root: null, binding: "missing-type", created: false };
    // The same logical owner survives portable copies between its installations.
    // Distinct owners have distinct IDs/slugs; these hashes grant no authority.
    const id = await stableGraphId("onto:installation-owner-root:v1", root.kind, root.id);
    const slug = `owner-${id}`;
    if (graph.nodes.some(n => n.id === id || (n.typeId === typeId && n.slug === slug)))
      return { status: "blocked", root: null, binding: "identity-collision", created: false };
    const properties: Record<string, string> = root.kind === "organization" ? { organization_id: root.id } : {};
    const input = { requestKey: crypto.randomUUID(), operations: [{ operation: "create" as const, ref: "$owner", type: "graph-node" as const,
      attributes: { id, typeId, slug, title: root.kind === "organization" ? "Installation owner organization" : "Installation owner account", properties } }] };
    // The bootstrap uses the same ontology validator as normal graph writes.
    let projected: Graph;
    try { projected = projectGraphChanges(graph, who, input); } catch (error) {
      if (error instanceof Response && [400, 409].includes(error.status))
        return { status: "blocked", root: null, binding: "schema-conflict", created: false, reason: await error.text() };
      throw error;
    }
    const row = projected.nodes.find(n => n.id === id)!;
    const key = root.kind === "user" ? userKey(root.id) : null;
    try {
      await guardedGraphBatch(db, who, graph, [sql`INSERT INTO graph_nodes
        (id,typeId,slug,title,summary,body,properties,externalKey,archived,revision,createdBy,updatedBy,createdAt,updatedAt)
        VALUES(${id},${typeId},${slug},${row.title},${row.summary},${row.body},${JSON.stringify(properties)},${key},0,1,${who.userId},${who.userId},${row.createdAt},${row.updatedAt})`], "Graph changed during owner setup; retry");
      const status = await ownerRootStatus(db, who);
      return { ...status, created: true };
    } catch (error) {
      if (!(error instanceof Response) || error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw new Response("Owner setup needs retry", { status: 409 });
}
