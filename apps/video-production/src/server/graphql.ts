import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import {
  GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType, GraphQLSchema, GraphQLString,
} from "graphql";
import { batchGroups } from "./batch-groups";
import type { VideoContext } from "./context";
import { readStoryboards, stageStoryboard } from "./graph";
import { stageInput } from "./onto";

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
const list = <T extends GraphQLNullableType>(type: T) => nonNull(new GraphQLList(nonNull(type)));
const strings = (...names: string[]) => Object.fromEntries(names.map((name) => [name, { type: nonNull(GraphQLString) }]));
const numbers = (...names: string[]) => Object.fromEntries(names.map((name) => [name, { type: GraphQLFloat }]));
const linkFields = { id: { type: nonNull(GraphQLID) }, address: { type: nonNull(GraphQLString), description: "Slug, or ID when the record has none." }, title: { type: nonNull(GraphQLString) } };

const link = new GraphQLObjectType({ name: "OntoLink", fields: linkFields });
const reference = new GraphQLObjectType({
  name: "VisualReference", description: "Something a shot must match. hasFile false means it is a requirement still to be made.",
  fields: { ...linkFields, ...strings("status", "requirements", "fileUri", "version"), hasFile: { type: nonNull(GraphQLBoolean) } },
});
const shot = new GraphQLObjectType({
  name: "Shot", description: "One beat of a storyboard, in sequence order.",
  fields: {
    ...linkFields, sequence: { type: GraphQLInt }, ...numbers("startSeconds", "durationSeconds"),
    ...strings("beat", "action", "camera", "voiceover", "overlay", "sound", "transition", "sourceRoute", "claimStatus", "status"),
    references: { type: list(reference) },
  },
});
const storyboard = new GraphQLObjectType({
  name: "Storyboard", description: "The plan for one video. A plan, not evidence that the video exists.",
  fields: {
    ...linkFields, ...strings("summary", "aspectRatio", "variant", "opening", "status"), ...numbers("durationSeconds"),
    brief: { type: link }, cutFrom: { type: link, description: "The longer storyboard this is a cut of." }, shots: { type: list(shot) },
  },
});
const brief = new GraphQLObjectType({
  name: "CreativeBrief",
  fields: {
    ...linkFields, ...strings("summary", "audience", "singleMessage", "claimBoundary", "callToAction", "successMetric", "status"),
    promotes: { type: list(link), description: "Products or offerings it is for." }, storyboards: { type: list(storyboard) },
  },
});
const storyboards = new GraphQLObjectType({
  name: "Storyboards", fields: { briefs: { type: list(brief) }, unbriefed: { type: list(storyboard), description: "Storyboards that follow no brief." } },
});
const staged = new GraphQLObjectType({
  name: "StagedStoryboard", description: "The Onto change batch a storyboard was staged in.",
  fields: {
    batchId: { type: GraphQLID, description: "Null when the Onto already had everything." },
    state: { type: GraphQLString, description: "awaiting_review until a member decides it in Onto." },
    proposals: { type: nonNull(GraphQLInt) },
    storyboardId: { type: nonNull(GraphQLID) },
    ontoPath: { type: nonNull(GraphQLString), description: "The Onto's address; its review page is changes/<batchId> there." },
  },
});

const baseSchema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, VideoContext>({
    name: "Query",
    fields: {
      storyboards: {
        type: nonNull(storyboards), description: "Creative briefs with their storyboards, each storyboard's shots in sequence order and the references each shot needs, from the organization's Onto.",
        resolve: (_source, _args, context) => readStoryboards(context.host()),
      },
    },
  }),
  mutation: new GraphQLObjectType<unknown, VideoContext>({
    name: "Mutation",
    fields: {
      stageStoryboard: mutationField({
        name: "StageStoryboard",
        description: "Stage a creative brief, one storyboard, its shots and their visual references in the organization's Onto as one change batch and submit it for review. Reuse records by existingId; records and links the Onto has are not proposed again, and existing records are not changed. Shot order and timing go in sequence, start_seconds and duration_seconds, never in titles. Editors only.",
        input: stageInput, output: nonNull(staged),
        run: (context: VideoContext, input) => stageStoryboard(context.identity, context.host(), input),
      }),
    },
  }),
});

export const graphqlSchema = batchSchema(baseSchema, batchGroups);
