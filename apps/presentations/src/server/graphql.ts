import {
  listMedia,
  reserveMediaInput,
  reserveMedia,
} from "@ai-outfitter/creative-workflow/media";
import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import {
  defineDocuments,
  publishDocuments,
} from "@ai-outfitter/app-sdk/app-documents";
import { JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { creativeQuery } from "@ai-outfitter/creative-workflow/graph";
import type { context } from "./context";
type Context = ReturnType<typeof context>;
const fields = {
  presentationArtifacts: {
    type: JSONScalar,
    args: { after: { type: GraphQLString } },
    resolve: (_s: unknown, args: { after?: string }, c: Context) =>
      listMedia(c, args.after),
  },
  creativeRecords: {
    type: JSONScalar,
    args: { after: { type: GraphQLString } },
    resolve: async (_s: unknown, args: { after?: string }, c: Context) => {
      const result: any = await creativeQuery(
        c.host(),
        `query($after:String){creativeRecords(after:$after,limit:50)}`,
        args,
      );
      if (result.errors?.length)
        throw new Response("Creative graph unavailable", { status: 502 });
      return result.data.creativeRecords;
    },
  },
};
export const graphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields }),
  mutation: new GraphQLObjectType({
    name: "Mutation",
    fields: {
      reservePresentationArtifact: mutationField<
        typeof reserveMediaInput,
        Context
      >({
        name: "ReservePresentationArtifact",
        description:
          "Reserve a hash-verified private deck or illustration upload.",
        input: reserveMediaInput,
        run: reserveMedia,
      }),
    },
  }),
});
const entries = defineDocuments({
  PresentationArtifacts: {
    story:
      "As a member, I want to review rendered decks and illustrations, so that I can download the agent-created results.",
    document: `query PresentationArtifacts($after:String){presentationArtifacts(after:$after)}`,
  },
  ReservePresentationArtifact: {
    story:
      "As an agent, I want to upload a rendered deck or illustration privately, so that members can review and download it.",
    document: `mutation ReservePresentationArtifact($input:ReservePresentationArtifactInput!){reservePresentationArtifact(input:$input)}`,
  },
  CreativeRecords: {
    story:
      "As a member, I want to read shared creative records, so that I can reuse descriptions and selections across apps.",
    document: `query CreativeRecords($after:String){creativeRecords(after:$after)}`,
  },
});
export const documents = publishDocuments(
  entries,
  Object.fromEntries(
    Object.keys(entries).map((name) => [
      name,
      { description: entries[name as keyof typeof entries].story },
    ]),
  ),
);
export async function runDocument(
  source: string,
  variables: Record<string, unknown>,
  contextValue: Context,
): Promise<any> {
  const result = await graphql({
    schema: graphqlSchema,
    source,
    variableValues: variables,
    contextValue,
  });
  if (result.errors?.length)
    throw result.errors[0].originalError ?? new Error(result.errors[0].message);
  return result.data;
}
