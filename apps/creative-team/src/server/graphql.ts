import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { mutationField, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import {
  type GraphQLFieldConfig, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType, GraphQLSchema, GraphQLString, getNamedType,
} from "graphql";
import type { z } from "zod";
import { brandSections } from "../lib/brand";
import type { CreativeContext } from "./context";
import { batchGroups } from "./batch-groups";
import { brandAnswers, contentProfile, drafts, mapNodes, sources, wikiBatches } from "./schema";
import { stageInput, stageInterview } from "./wiki";
import {
  addBranch, answerInput, branchInput, deleteDraft, deleteInput, deleteNode, deleteSource, draftInput, nodeInput, profileInput, saveAnswer, saveDraft, saveNode,
  saveProfile, saveSource, sourceInput,
} from "./store";

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
/** The row type a tableType collection pages (`<Type>Connection.nodes`), so a mutation returns the record a read does. */
const rowType = (collection: GraphQLFieldConfig<unknown, never>) =>
  getNamedType((getNamedType(collection.type) as GraphQLObjectType).getFields().nodes.type) as GraphQLObjectType;

const answerRows = tableType(brandAnswers, { field: "brandAnswers", type: "BrandAnswer", fields: ["answer", "revision", "updatedAt"], dates: ["updatedAt"] });
const sourceRows = tableType(sources, {
  field: "sources", type: "Source", fields: ["kind", "name", "platform", "handle", "url", "examples", "notes", "revision", "updatedAt"], dates: ["updatedAt"], filters: ["kind"],
});
const profileRows = tableType(contentProfile, { field: "contentProfiles", type: "ContentProfile", fields: ["coreIdeas", "voice", "worldview", "patterns", "revision", "updatedAt"], dates: ["updatedAt"] });
const nodeRows = tableType(mapNodes, {
  field: "mapNodes", type: "MapNode", fields: ["parentId", "level", "title", "notes", "research", "position", "revision", "updatedAt"], dates: ["updatedAt"], ids: ["parentId"],
  filters: ["level", "parentId"],
});
const draftRows = tableType(drafts, {
  field: "drafts", type: "Draft", fields: ["nodeId", "format", "title", "body", "status", "revision", "updatedAt"], dates: ["updatedAt"], ids: ["nodeId"], filters: ["status", "nodeId"],
});
const row = (collection: Record<string, GraphQLFieldConfig<unknown, never>>) => nonNull(rowType(Object.values(collection)[0]));

const question = new GraphQLObjectType({ name: "BrandQuestion", description: "One onboarding interview question; its answer is the BrandAnswer with the same id.", fields: {
  id: { type: nonNull(GraphQLID) }, section: { type: nonNull(GraphQLString) }, sectionTitle: { type: nonNull(GraphQLString) }, text: { type: nonNull(GraphQLString) }, hint: { type: GraphQLString },
} });
const deleted = new GraphQLObjectType({ name: "Deleted", fields: { id: { type: nonNull(GraphQLID) }, deleted: { type: nonNull(GraphQLInt), description: "Records removed." } } });
const branchResult = new GraphQLObjectType({ name: "MapBranchAdded", fields: {
  added: { type: nonNull(GraphQLInt), description: "Map nodes added, at every level." },
  ids: { type: nonNull(new GraphQLList(nonNull(GraphQLID))), description: "The top nodes of the branch, in order." },
} });

const wikiBatch = new GraphQLObjectType({ name: "BrandWikiBatch", description: "The Wiki change batch a brand interview was staged in.", fields: {
  batch: { type: GraphQLString, description: "The batch's slug in the Wiki; null when the Wiki already had everything." },
  state: { type: GraphQLString, description: "awaiting_review until the member (or the Wiki's policy) decides it." },
  proposals: { type: nonNull(GraphQLInt), description: "Records and links proposed." },
  wikiPath: { type: nonNull(GraphQLString), description: "The Wiki's address; its Changes page lists the batch for review." },
} });
const batchRows = tableType(wikiBatches, { field: "brandWikiBatches", type: "BrandWikiBatchRow", fields: ["wikiInstallationId", "wikiPath", "state", "proposals", "createdAt", "updatedAt"], dates: ["createdAt", "updatedAt"] });

const editors = "Editors only: the owner of a personal installation, or an organization's owners and admins.";
const field = <I extends z.ZodType>(name: string, description: string, input: I, output: GraphQLObjectType | GraphQLNonNull<GraphQLObjectType>, run: (context: CreativeContext, input: z.output<I>) => unknown) =>
  mutationField<I, CreativeContext>({ name, description: `${description} ${editors}`, input, output: output instanceof GraphQLNonNull ? output : nonNull(output), run });

const mutation = new GraphQLObjectType<unknown, CreativeContext>({
  name: "Mutation",
  fields: {
    saveBrandAnswer: field("SaveBrandAnswer", "Save the answer to one brand interview question (brandQuestions). Omit revision for a question with no answer yet; otherwise send the revision you read.",
      answerInput, row(answerRows), (context, input) => saveAnswer(context.db(), context.identity, input)),
    stageBrandInterview: field("StageBrandInterview", "Save the brand interview to the member's Wiki as one change batch for review: a BrandInterview document (JSON body, answers in the member's words) plus the people, audiences (CustomerSegment), problems, offerings and goals the answers name, reusing existing Wiki records by existingId, and the links between them. Submits the batch; nothing commits until it is reviewed on the Wiki's Changes page. Refused while the previous interview batch still awaits review.",
      stageInput, wikiBatch, async (context, input) => {
        const saved = await stageInterview(context.db(), context.identity, context.host(), input);
        return { batch: saved.batch?.id ?? null, state: saved.batch?.state ?? null, proposals: saved.proposals, wikiPath: saved.wikiPath };
      }),
    saveSource: field("SaveSource", "Add a content source (omit id): the creator's own posts on one platform (kind own) or a person who shaped their thinking (kind influence), with pasted examples and notes on their core ideas, voice and worldview. With id and revision, change one; omitted fields are kept.",
      sourceInput, row(sourceRows), (context, input) => saveSource(context.db(), context.identity, input)),
    deleteSource: field("DeleteSource", "Remove a content source at the revision you read.", deleteInput, deleted, (context, input) => deleteSource(context.db(), context.identity, input)),
    saveContentProfile: field("SaveContentProfile", "Save the content document's synthesis across every source: core ideas, voice, worldview and replicable patterns. Omitted fields are kept; send the revision you read, or none when it is not saved yet.",
      profileInput, row(profileRows), (context, input) => saveProfile(context.db(), context.identity, input)),
    addMapBranch: field("AddMapBranch", "Add to the content map. Without parentId, nodes are pillars; under a pillar they are topics, under a topic ideas, under an idea angles. Each node may carry children down to angles. A full map has 3-4 pillars, 5-7 topics each, 5-10 ideas per topic and 4-5 angles per idea. Put what an idea is based on (a reference post or a pattern seen performing, and where it came from) in research; never invent performance numbers.",
      branchInput, branchResult, (context, input) => addBranch(context.db(), context.identity, input)),
    saveMapNode: field("SaveMapNode", "Change one map node's title, notes, research or position at the revision you read.", nodeInput, row(nodeRows), (context, input) => saveNode(context.db(), context.identity, input)),
    deleteMapNode: field("DeleteMapNode", "Remove a map node and everything below it at the revision you read; drafts written from them are kept, unlinked.", deleteInput, deleted,
      (context, input) => deleteNode(context.db(), context.identity, input)),
    saveDraft: field("SaveDraft", "Save a post draft (omit id to add one), optionally written from a map idea or angle (nodeId). Drafts are for the member to rewrite and post; nothing is posted.",
      draftInput, row(draftRows), (context, input) => saveDraft(context.db(), context.identity, input)),
    deleteDraft: field("DeleteDraft", "Remove a draft at the revision you read.", deleteInput, deleted, (context, input) => deleteDraft(context.db(), context.identity, input)),
  },
});

/** What this app serves over graph.graphql and graph.mutate (printed to graph/schema.graphql by
 * scripts/graph-schema.ts): the brand interview and its answers, the content document, the
 * content map and the drafts, and the writes its pages and agents run (documents.ts). */
const baseSchema = new GraphQLSchema({
  query: new GraphQLObjectType<unknown, CreativeContext>({
    name: "Query",
    fields: {
      brandQuestions: {
        type: nonNull(new GraphQLList(nonNull(question))), description: "The onboarding interview that builds the brand document, in order.",
        resolve: () => brandSections.flatMap((section) => section.questions.map((item) => ({ ...item, section: section.id, sectionTitle: section.title, hint: item.hint ?? null }))),
      },
      ...answerRows, ...sourceRows, ...profileRows, ...nodeRows, ...draftRows, ...batchRows,
    },
  }),
  mutation,
});

export const graphqlSchema = batchSchema(baseSchema, batchGroups);
