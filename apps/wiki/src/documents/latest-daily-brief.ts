import { GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString } from "graphql";
import type { Context } from "./graphql";

// The slug index sorts Forerunner's dated pages newest first. Read the current
// revision so edits and archives take effect immediately, including older briefs.
export const latestDailyBrief = {
  type: new GraphQLObjectType({
    name: "SavedDailyBrief",
    fields: {
      documentId: { type: GraphQLID }, revision: { type: GraphQLInt },
      slug: { type: GraphQLString }, date: { type: GraphQLString },
      timezone: { type: GraphQLString }, status: { type: GraphQLString },
      markdown: { type: GraphQLString }, savedAt: { type: GraphQLString },
    },
  }),
  async resolve(_: unknown, __: unknown, ctx: Context) {
    if (ctx.identity.owner.kind !== "user") return null;
    const [row] = await ctx.database.query({
      sql: `SELECT p.slug,d.id AS documentId,d.revision,r.generatedBody AS markdown,
        json_extract(r.provenance,'$.date') AS date,
        json_extract(r.provenance,'$.timezone') AS timezone,
        json_extract(r.provenance,'$.status') AS status,r.createdAt
        FROM wiki_pages p JOIN wiki_documents d ON d.id=p.documentId
        JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision
        WHERE p.slug GLOB 'forerunner-brief-????-??-??-*' AND d.archived=0
        AND json_extract(r.provenance,'$.kind')='forerunner.daily-brief'
        AND json_extract(r.provenance,'$.owner.id')=?
        ORDER BY p.slug DESC LIMIT 1`,
      params: [ctx.identity.owner.id],
    });
    return row ? {...row,savedAt:new Date(Number(row.createdAt)).toISOString()} : null;
  },
};
