import {
  transferInput,
  importTransferInput,
  beginTransfer,
  exportTransfer,
  importTransfer,
  transferReceipt,
  finishTransfer,
} from "@ai-outfitter/creative-workflow/video-transfer";
import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLInt,
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
import {
  saveVideoInput,
  videoTakeInput,
  takeUpdateInput,
  videoAssetInput,
  assetCommitInput,
  publishVideoInput,
} from "@ai-outfitter/creative-workflow/video-model";
import {
  readVideos,
  saveProduction,
  prepareTake,
  updateTake,
  reserveAsset,
  commitAsset,
  publishProduction,
} from "@ai-outfitter/creative-workflow/video-store";
const fields = {
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
  videoTransfer: {
    type: JSONScalar,
    args: { id: { type: GraphQLID } },
    resolve: (_s: unknown, args: { id: string }, c: Context) =>
      exportTransfer(c, args.id),
  },
  videoTransferReceipt: {
    type: JSONScalar,
    args: { id: { type: GraphQLID } },
    resolve: (_s: unknown, args: { id: string }, c: Context) =>
      transferReceipt(c, args.id),
  },
  videoProductions: {
    type: JSONScalar,
    args: {
      id: { type: GraphQLID },
      revision: { type: GraphQLInt },
      after: { type: GraphQLString },
      limit: { type: GraphQLInt },
    },
    resolve: (_s: unknown, args: unknown, c: Context) => readVideos(c, args),
  },
};
export const graphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields }),
  mutation: new GraphQLObjectType({
    name: "Mutation",
    fields: {
      beginVideoTransfer: mutationField<typeof transferInput, Context>({
        name: "BeginVideoTransfer",
        description:
          "Seal a production for a verified transfer; blocks further source writes.",
        input: transferInput,
        run: beginTransfer,
      }),
      importVideoTransfer: mutationField<typeof importTransferInput, Context>({
        name: "ImportVideoTransfer",
        description:
          "Read a sealed source through its authorized app and preserve revisions and receipts. Media must still be copied.",
        input: importTransferInput,
        run: importTransfer,
      }),
      finishVideoTransfer: mutationField<typeof publishVideoInput, Context>({
        name: "FinishVideoTransfer",
        description:
          "Verify destination metadata and media before recording completion.",
        input: publishVideoInput,
        run: (c, input) => finishTransfer(c, input.id),
      }),
      saveVideoProduction: mutationField<typeof saveVideoInput, Context>({
        name: "SaveVideoProduction",
        description: "Save a versioned storyboard.",
        input: saveVideoInput,
        run: saveProduction,
      }),
      prepareVideoTake: mutationField<typeof videoTakeInput, Context>({
        name: "PrepareVideoTake",
        description: "Prepare without submitting a new generation.",
        input: videoTakeInput,
        run: prepareTake,
      }),
      updateVideoTake: mutationField<typeof takeUpdateInput, Context>({
        name: "UpdateVideoTake",
        description: "Claim or reconcile a take with revision checks.",
        input: takeUpdateInput,
        run: updateTake,
      }),
      reserveVideoAsset: mutationField<typeof videoAssetInput, Context>({
        name: "ReserveVideoAsset",
        description: "Reserve a private upload with exact hash and size.",
        input: videoAssetInput,
        run: reserveAsset,
      }),
      commitVideoAsset: mutationField<typeof assetCommitInput, Context>({
        name: "CommitVideoAsset",
        description: "Verify and commit private uploaded bytes.",
        input: assetCommitInput,
        run: commitAsset,
      }),
      publishVideoProduction: mutationField<typeof publishVideoInput, Context>({
        name: "PublishVideoProduction",
        description: "Stage the production for graph review.",
        input: publishVideoInput,
        run: publishProduction,
      }),
    },
  }),
});
const entries = defineDocuments({
  VideoTransfer: {
    story:
      "As an agent, I want to read a sealed transfer, so that migration preserves exact metadata.",
    document: `query VideoTransfer($id:ID!){videoTransfer(id:$id)}`,
  },
  VideoTransferReceipt: {
    story:
      "As an agent, I want to verify imported media, so that source links switch only after validation.",
    document: `query VideoTransferReceipt($id:ID!){videoTransferReceipt(id:$id)}`,
  },
  BeginVideoTransfer: {
    story:
      "As an editor, I want to seal a production for transfer, so that an active take cannot be submitted twice.",
    document: `mutation BeginVideoTransfer($input:BeginVideoTransferInput!){beginVideoTransfer(input:$input)}`,
  },
  ImportVideoTransfer: {
    story:
      "As an editor, I want to import sealed production records, so that revisions and receipts survive migration.",
    document: `mutation ImportVideoTransfer($input:ImportVideoTransferInput!){importVideoTransfer(input:$input)}`,
  },
  FinishVideoTransfer: {
    story:
      "As an editor, I want to verify destination media, so that migration completes only when downloads are intact.",
    document: `mutation FinishVideoTransfer($input:FinishVideoTransferInput!){finishVideoTransfer(input:$input)}`,
  },

  CreativeRecords: {
    story:
      "As a member, I want to read shared creative records, so that I can reuse descriptions and selections across apps.",
    document: `query CreativeRecords($after:String){creativeRecords(after:$after)}`,
  },
  VideoProductions: {
    story:
      "As a member, I want to review saved films and storyboards, so that I can choose and download a finished edit.",
    document: `query VideoProductions($id:ID,$revision:Int,$after:String,$limit:Int){videoProductions(id:$id,revision:$revision,after:$after,limit:$limit)}`,
  },
  SaveVideoProduction: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation SaveVideoProduction($input:SaveVideoProductionInput!){saveVideoProduction(input:$input)}`,
  },
  PrepareVideoTake: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation PrepareVideoTake($input:PrepareVideoTakeInput!){prepareVideoTake(input:$input)}`,
  },
  UpdateVideoTake: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation UpdateVideoTake($input:UpdateVideoTakeInput!){updateVideoTake(input:$input)}`,
  },
  ReserveVideoAsset: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation ReserveVideoAsset($input:ReserveVideoAssetInput!){reserveVideoAsset(input:$input)}`,
  },
  CommitVideoAsset: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation CommitVideoAsset($input:CommitVideoAssetInput!){commitVideoAsset(input:$input)}`,
  },
  PublishVideoProduction: {
    story:
      "As an agent, I want to manage revision-checked video production, so that members can review verified private media.",
    document: `mutation PublishVideoProduction($input:PublishVideoProductionInput!){publishVideoProduction(input:$input)}`,
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
