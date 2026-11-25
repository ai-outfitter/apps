import { GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLResolveInfo } from "graphql";
import { connectionType, page, pageArgs, pageStart, type PageArgs } from "@ai-outfitter/app-sdk/app-graphql";
import type { GraphContext } from "@ai-outfitter/app-sdk/graph-graphql";
import { z } from "zod";
import type { Context } from "./graphql";

const revision = new GraphQLObjectType({
  name: "WikiRevisionActivity",
  fields: {
    id: { type: GraphQLID }, slug: { type: GraphQLString }, revision: { type: GraphQLInt },
    title: { type: GraphQLString }, createdAt: { type: GraphQLString }, store: { type: GraphQLString },
  },
});

// Both readers use the legacy ledger alias r. Once a mapped document is
// archived, its old ledger body must no longer be exposed on either surface.
export const legacyRevisionNotArchived = `NOT EXISTS (
  SELECT 1 FROM wiki_documents d WHERE d.archived=1 AND (d.id=r.recordId OR d.legacyNodeId=r.recordId)
)`;

// A cutover copy has the same document ID and revision; its original ledger row
// remains available for historical lookup but should count only once.
const activity = `WITH activity AS (
  SELECT r.documentId AS id, (SELECT min(slug) FROM wiki_pages WHERE documentId=r.documentId) AS slug,
    r.revision, r.title, r.createdAt, 'document' AS store
  FROM wiki_document_revisions r JOIN wiki_documents d ON d.id=r.documentId
  WHERE r.createdAt>=? AND r.createdAt<? AND d.archived=0
    AND coalesce(json_extract(r.provenance,'$.kind'),'') NOT IN ('forerunner.daily-brief','app.daily-update','planning.daily-report')
    AND (r.generatedBody='' OR EXISTS (SELECT 1 FROM wiki_document_revisions prior
      WHERE prior.documentId=r.documentId AND prior.revision=r.revision-1
        AND (prior.title<>r.title OR prior.summary<>r.summary OR prior.body<>r.body)))
    AND NOT EXISTS (SELECT 1 FROM wiki_pages p WHERE p.documentId=r.documentId AND
      (p.slug GLOB 'forerunner-brief-*' OR p.slug GLOB 'app-daily-*'))
  UNION ALL
  SELECT r.recordId, coalesce(n.slug,json_extract(r.snapshot,'$.slug')), r.revision,
    coalesce(json_extract(r.snapshot,'$.title'),n.title,''), r.createdAt, 'legacy'
  FROM graph_revisions r JOIN graph_nodes n ON n.id=r.recordId
    JOIN graph_types t ON t.id=n.typeId AND t.name='Document'
  WHERE r.createdAt>=? AND r.createdAt<? AND r.kind='graph-node' AND n.archived=0
    AND ${legacyRevisionNotArchived}
    AND coalesce(n.slug,'') NOT GLOB 'forerunner-brief-*' AND coalesce(n.slug,'') NOT GLOB 'app-daily-*'
    AND NOT EXISTS (SELECT 1 FROM wiki_documents d JOIN wiki_document_revisions x ON x.documentId=d.id
      WHERE (d.id=r.recordId OR d.legacyNodeId=r.recordId) AND x.revision=r.revision)
)`;
const key = "printf('%013d:%s:%010d',createdAt,id,revision)";

export const wikiRevisionActivity = {
  type: new GraphQLNonNull(connectionType(revision)),
  args: { ...pageArgs(), start: { type: new GraphQLNonNull(GraphQLString) }, end: { type: new GraphQLNonNull(GraphQLString) } },
  async resolve(_: unknown, args: PageArgs & { start: string; end: string }, ctx: Context & GraphContext, info: GraphQLResolveInfo) {
    const [from, to] = [args.start, args.end].map(value => Date.parse(z.iso.datetime().parse(value)));
    if (from < 0 || to <= from || to - from > 26 * 3_600_000) throw new Error("Expected one local reporting day");
    const { first, start } = pageStart(args);
    const params = [from, to, from, to];
    const rows = await ctx.database.query({
      sql: `${activity} SELECT *, ${key} AS cursor FROM activity WHERE ${key}>? ORDER BY cursor LIMIT ?`,
      params: [...params, start ?? "", first + 1],
    });
    const results = rows.map(row => ({ ...row, cursor: String(row.cursor), createdAt: new Date(Number(row.createdAt)).toISOString() }));
    return page(ctx, info, results, row => String(row.cursor), first, start, async () =>
      Number((await ctx.database.query({ sql: `${activity} SELECT count(*) AS n FROM activity`, params }))[0].n));
  },
};
