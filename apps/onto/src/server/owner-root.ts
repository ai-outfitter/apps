import { eq, sql } from "drizzle-orm";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requireEditor, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { userKey } from "@ai-outfitter/app-sdk/graph-contracts";
import { core } from "../lib/graph";
import { readGraph } from "./graph";
import { graphNodes, graphEdges } from "./schema";
import { guardedGraphBatch } from "./graph-batch";
import { checkGraphChanges } from "./graph-changes";
import { wikiHome } from "./wiki-home";
import { resolveIdentity } from "./identity";

type Database = ReturnType<typeof installationDatabase>;
const accountType = "71000000-0000-4000-8000-000000000120";
const accountOf = "71000000-0000-4000-8000-000000000122";
function owner(who: AppIdentity) {
  if (
    !who.owner?.id ||
    !who.installationId ||
    (who.owner.kind === "organization"
      ? who.organizationId !== who.owner.id
      : Boolean(who.organizationId))
  )
    throw new Response("Inconsistent installation owner", { status: 403 });
  return who.owner;
}
/** Keep the existing verified holder; a canonical account is a truthful fallback,
 * without assuming that a platform user is a particular Person or Agent. */
export async function personalRoot(db: Database, who: AppIdentity) {
  const scope = owner(who);
  if (scope.kind !== "user") return null;
  try {
    const holder = await resolveIdentity(db, { principalId: scope.id });
    if (holder) return holder.holderId;
  } catch {
    return null;
  }
  const [account] = await db
    .select()
    .from(graphNodes)
    .where(eq(graphNodes.externalKey, userKey(scope.id)));
  if (!account || account.archived || account.typeId !== accountType)
    return null;
  // Invalid/archived targets of active links are not permission to ignore identity history.
  const links = await db
    .select()
    .from(graphEdges)
    .where(eq(graphEdges.fromId, account.id));
  return links.some((edge) => !edge.archived && edge.typeId === accountOf)
    ? null
    : account.id;
}

/** Called only by the existing editor-authorized installation/upgrade initializer.
 * Adds missing owner records; never adopts by name, resurrects archives or links data. */
export async function initializeOwnerRoot(db: Database, who: AppIdentity) {
  requireEditor(who);
  const scope = owner(who);
  for (let attempt = 0; attempt < 3; attempt++) {
    const graph = await readGraph(db, who);
    if (scope.kind === "organization") {
      if (wikiHome(graph, who).organizationId) return { status: "kept" };
      const matches = graph.nodes.filter(
        (n) =>
          n.typeId === core.organization &&
          n.properties.organization_id === scope.id,
      );
      const active = matches.filter((n) => !n.archived);
      if (matches.length)
        return {
          status: "blocked",
          reason: active.length
            ? "ambiguous owner binding"
            : "archived owner binding",
        };
    } else {
      const [account] = await db
        .select()
        .from(graphNodes)
        .where(eq(graphNodes.externalKey, userKey(scope.id)));
      if (account)
        return (await personalRoot(db, who))
          ? { status: "kept" }
          : {
              status: "blocked",
              reason: "existing account identity requires reconciliation",
            };
    }
    const typeId =
      scope.kind === "organization" ? core.organization : accountType;
    const id = await stableGraphId(
      "onto:installation-owner-root:v1",
      scope.kind,
      scope.id,
    );
    const slug = `owner-${id}`;
    if (
      graph.nodes.some(
        (n) => n.id === id || (n.typeId === typeId && n.slug === slug),
      )
    )
      return { status: "blocked", reason: "owner record identity is occupied" };
    const properties: Record<string, string> =
      scope.kind === "organization" ? { organization_id: scope.id } : {};
    const title =
      scope.kind === "organization"
        ? "Installation owner organization"
        : "Installation owner account";
    try {
      await checkGraphChanges(db, who, {
        requestKey: crypto.randomUUID(),
        operations: [
          {
            operation: "create",
            ref: "$owner",
            type: "graph-node",
            attributes: { id, typeId, slug, title, properties },
          },
        ],
      });
    } catch (error) {
      if (error instanceof Response && error.status === 409 && attempt < 2)
        continue;
      if (error instanceof Response && [400, 409].includes(error.status))
        return { status: "blocked", reason: await error.text() };
      throw error;
    }
    const now = Date.now(),
      key = scope.kind === "user" ? userKey(scope.id) : null;
    try {
      await guardedGraphBatch(
        db,
        who,
        graph,
        [
          sql`INSERT INTO graph_nodes
        (id,typeId,slug,title,properties,externalKey,archived,revision,createdBy,updatedBy,createdAt,updatedAt)
        VALUES(${id},${typeId},${slug},${title},${JSON.stringify(properties)},${key},0,1,${who.userId},${who.userId},${now},${now})`,
        ],
        "Graph changed during owner setup; retry",
      );
      return { status: "created" };
    } catch (error) {
      if (!(error instanceof Response) || error.status !== 409 || attempt === 2)
        throw error;
    }
  }
  throw new Response("Owner setup needs retry", { status: 409 });
}
