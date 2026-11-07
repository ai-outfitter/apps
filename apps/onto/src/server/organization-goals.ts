import {
  defineEntity,
  type EntityRef,
  entityRef,
} from "@ai-outfitter/app-sdk/entities";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { core } from "../lib/graph";
import { plainText } from "../lib/plain-text";
import type { Database } from "./graph";
import { graphEdges, graphNodes } from "./schema";

export const organizationGoalsLimit = 20;

const revision = z.number().int().positive();
const summary = z.string().max(280);
export const organizationGoals = z.strictObject({
  organization: z.strictObject({
    ref: entityRef,
    revision,
    title: z.string(),
    summary,
  }),
  goals: z
    .array(
      z.strictObject({
        ref: entityRef,
        revision,
        title: z.string(),
        summary,
        pursuit: z.strictObject({ ref: entityRef, revision }),
      }),
    )
    .max(organizationGoalsLimit),
  truncated: z.boolean(),
});
type Projection = z.infer<typeof organizationGoals> & {
  id: string;
  revision: number;
  title: string;
};

const fail = (message: string, status: number): never => {
  throw new Response(message, { status });
};
const activeOrganization = and(
  eq(graphNodes.typeId, core.organization),
  eq(graphNodes.archived, false),
);

async function project(
  db: Database,
  installationId: string,
  root: { id: string; revision: number; title: string; summary: string },
): Promise<Projection> {
  const ref = (type: string, id: string): EntityRef => ({
    installationId,
    type,
    id,
  });
  // Outgoing `pursues` only, each to an active Goal; one indexed, bounded join.
  const rows = await db
    .select({
      id: graphNodes.id,
      revision: graphNodes.revision,
      title: graphNodes.title,
      summary: graphNodes.summary,
      edgeId: graphEdges.id,
      edgeRevision: graphEdges.revision,
    })
    .from(graphEdges)
    .innerJoin(graphNodes, eq(graphNodes.id, graphEdges.toId))
    .where(
      and(
        eq(graphEdges.fromId, root.id),
        eq(graphEdges.typeId, core.pursues),
        eq(graphEdges.archived, false),
        eq(graphNodes.typeId, core.goal),
        eq(graphNodes.archived, false),
      ),
    )
    .orderBy(asc(graphNodes.title), asc(graphNodes.id))
    .limit(organizationGoalsLimit + 1);
  return {
    id: root.id,
    revision: root.revision,
    title: root.title,
    organization: {
      ref: ref("graph-node", root.id),
      revision: root.revision,
      title: root.title,
      summary: plainText(root.summary, 280),
    },
    goals: rows.slice(0, organizationGoalsLimit).map((row) => ({
      ref: ref("graph-node", row.id),
      revision: row.revision,
      title: row.title,
      summary: plainText(row.summary, 280),
      pursuit: {
        ref: ref("graph-edge", row.edgeId),
        revision: row.edgeRevision,
      },
    })),
    truncated: rows.length > organizationGoalsLimit,
  };
}

const rootColumns = {
  id: graphNodes.id,
  revision: graphNodes.revision,
  title: graphNodes.title,
  summary: graphNodes.summary,
};

/** A read-only, bounded view over the typed graph: never a stored record or a query language. */
export function organizationGoalsEntity(db: Database) {
  return defineEntity<Projection, typeof organizationGoals>({
    type: "organization-goals",
    collection: "organization-goals",
    selectFields: Object.keys(organizationGoals.shape),
    title: "Organization goals",
    description: `Read-only projection keyed by an active Organization graph-node ID: up to ${organizationGoalsLimit} active Goal nodes the organization pursues through outgoing \`pursues\` relationships, with their graph-node and graph-edge references and revisions. Unknown, archived or non-Organization IDs are not found. It records no progress; edit the underlying graph-node and graph-edge records instead.`,
    schema: organizationGoals,
    name: (row) => row.title,
    attributes: ({ organization, goals, truncated }) => ({
      organization,
      goals,
      truncated,
    }),
    list: async (who, offset, limit) => {
      const roots = await db
        .select(rootColumns)
        .from(graphNodes)
        .where(activeOrganization)
        .orderBy(asc(graphNodes.id))
        .offset(offset)
        .limit(limit);
      return Promise.all(
        roots.map((root) => project(db, who.installationId, root)),
      );
    },
    get: async (who, id) => {
      const [root] = await db
        .select(rootColumns)
        .from(graphNodes)
        .where(and(eq(graphNodes.id, id), activeOrganization));
      return project(
        db,
        who.installationId,
        root ?? fail("Organization not found", 404),
      );
    },
  });
}
