import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLResolveInfo,
} from "graphql";
import {
  connectionType,
  page,
  pageArgs,
  pageStart,
  type PageArgs,
} from "@ai-outfitter/app-sdk/app-graphql";
import type { GraphContext } from "@ai-outfitter/app-sdk/graph-graphql";
import { parseAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import { z } from "zod";
import type { Context } from "./graphql";

const update = new GraphQLObjectType({
  name: "AppDailyUpdate",
  fields: {
    id: { type: GraphQLID },
    slug: { type: GraphQLString },
    app: { type: GraphQLString },
    summary: { type: GraphQLString },
    complete: { type: GraphQLBoolean },
    revision: { type: GraphQLInt },
    timezone: { type: GraphQLString },
  },
});

// Each Wiki reads only its own current generated revisions. The federation host adds the member-authorized scope.
export const dailyAppUpdates = {
  type: new GraphQLNonNull(connectionType(update)),
  args: { ...pageArgs(), date: { type: new GraphQLNonNull(GraphQLString) } },
  async resolve(
    _: unknown,
    args: PageArgs & { date: string },
    ctx: Context & GraphContext,
    info: GraphQLResolveInfo,
  ) {
    const date = z.iso.date().parse(args.date);
    const { first, start } = pageStart(args);
    const source = `FROM wiki_pages p JOIN wiki_documents d ON d.id=p.documentId
      JOIN wiki_document_revisions r ON r.documentId=d.id AND r.revision=d.revision
      WHERE d.archived=0 AND p.slug GLOB 'app-daily-*' AND json_extract(r.provenance,'$.kind')='app.daily-update'
      AND json_extract(r.provenance,'$.period.date')=?`;
    const rows = await ctx.database.query({
      sql: `SELECT p.slug, d.id, d.revision, json_extract(r.provenance,'$.app') AS app,
        r.generatedBody,
        json_extract(r.provenance,'$.period.timezone') AS timezone ${source} AND p.slug>? ORDER BY p.slug LIMIT ?`,
      params: [date, start ?? "", first + 1],
    });
    const updates = rows.map(({ generatedBody, ...row }) => {
      const body = parseAppUpdate(String(generatedBody));
      if (!body) throw new Error("Daily app update lacks a saved summary");
      return { ...row, slug: String(row.slug), ...body };
    });
    return page(
      ctx,
      info,
      updates,
      (row) => row.slug,
      first,
      start,
      async () =>
        Number(
          (
            await ctx.database.query({
              sql: `SELECT count(*) AS n ${source}`,
              params: [date],
            })
          )[0].n,
        ),
    );
  },
};
