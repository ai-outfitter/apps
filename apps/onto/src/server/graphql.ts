import { and, asc, eq, inArray, like, sql, gt } from "drizzle-orm";
import { graphBatches, graphBatchOperations } from "./schema";
import { connectionType, pageArgs } from "@ai-outfitter/app-sdk/app-graphql";
import { instructionType, resultInstructions } from "@ai-outfitter/app-sdk/batch-documents";
import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
import { documentMutations, documentQueries, type DocumentContext } from "./documents/graphql";
// The Wiki's change batches over GraphQL, for agents. Agents stage proposed records with
// the mutation documents (documents.ts) and a member commits them on the Changes page
// (batch.review stays a member's step there). graph.mutate runs graphqlSchema; the
// Wiki's graph.graphql serves changeQueries beside its generated types, so the
// printed schema (graph/schema.graphql) answers through both.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import { DateTimeScalar, JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import {
  type GraphQLFieldConfig, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType,
  GraphQLSchema, GraphQLString,
} from "graphql";
import { z } from "zod";
import { addToBatch, batchAddInput, batchRemoveInput, batchSource, batchSubmitInput, getBatch, openBatch, removeFromBatch, submitBatch, reviewBatch, batchReviewInput } from "./graph-batches";

/** What graph.graphql passes to these resolvers; graph.mutate passes the whole action context. */
export type ChangeContext = DocumentContext & { identity: AppIdentity; db: () => ReturnType<typeof installationDatabase>;
  /** Starts the ontology steward's review of a submitted batch in the background (graph.mutate only). */
  afterSubmit?: (batchId: string) => void };
type MutationContext = ChangeContext & ActionContext;

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
const text = { type: nonNull(GraphQLString) };
const json = { type: nonNull(JSONScalar) };

const StagedChange = new GraphQLObjectType({
  name: "StagedChange", description: "One proposed graph.apply operation in a batch.",
  fields: {
    ref: text,
    state: { ...text, description: "pending, awaiting_review, committed or rejected." },
    operation: json, evidence: json,
    confidence: { type: GraphQLFloat }, reason: { type: GraphQLString },
    decision: { type: JSONScalar, description: "Who or which policy decided it, and when." },
    recordId: { type: GraphQLID, description: "The committed record." }, recordRevision: { type: GraphQLInt },
  },
});
const ChangeBatch = new GraphQLObjectType({
  name: "ChangeBatch", description: "Proposed Wiki changes, invisible to every read until a member commits them on the Changes page.",
  fields: {
    id: { type: nonNull(GraphQLID) }, title: text, purpose: text,
    state: { ...text, description: "open, awaiting_review, committed, rejected or discarded." },
    source: { type: JSONScalar }, createdAt: { type: nonNull(DateTimeScalar) },
    policy: json, summary: { type: JSONScalar },
    reviewBy: { type: DateTimeScalar },
    review: { type: JSONScalar, description: "The ontology steward's latest advisory review: state, findings by operation ref, coverage, prompt digest and its batch-review workflow run, whose logs are the audit trail. It never approves or blocks anything." },
    expiresAt: { type: nonNull(DateTimeScalar) }, updatedAt: { type: nonNull(DateTimeScalar) },
    counts: { ...json, description: "Operations by state." },
    instructions: { type: nonNull(new GraphQLList(nonNull(instructionType))), resolve: batch => resultInstructions(batch.id, batch) },
    operations: {
      type: nonNull(new GraphQLList(nonNull(StagedChange))),
      args: { refs: { type: new GraphQLList(nonNull(GraphQLString)), description: "Read only these proposal refs; omit for all. Use to inspect individual proposals when the whole batch exceeds the response limit." } },
      resolve: async (batch, { refs }: { refs?: string[] | null }, context: ChangeContext) => {
        const operations = batch.operations ?? (await getBatch(context.db(), context.identity, {batchId:batch.id})).operations;
        return refs ? operations.filter((operation: {ref:string}) => refs.includes(operation.ref)) : operations;
      },
    },
  },
});

type Batch = Awaited<ReturnType<typeof getBatch>>;
const view = ({ batch, counts, operations }: Batch) => ({ ...batch, counts, operations });

const stageInput = z.strictObject({
  batchId: z.uuid().optional().describe("Add to this open batch; omit to open one."),
  title: z.string().min(1).max(200).optional().describe("Names the batch a new one opens with."),
  purpose: z.string().max(2000).optional(),
  source: batchSource.optional().describe("Where the proposals came from, for a new batch: {kind: \"agent-task\" | \"meeting\" | \"import\" | \"work-package\", ref, label?}, e.g. a chat or meeting ID and its title."),
  proposals: batchAddInput.shape.proposals,
}).refine(input => input.batchId || input.title, { message: "Pass batchId, or a title to open a batch", path: ["title"] });

export const changeQueries: Record<string, GraphQLFieldConfig<unknown, ChangeContext>> = {
  ...documentQueries,
  changeBatches: {
    type: nonNull(connectionType(ChangeBatch)), description: "Search saved change batches; operations and evidence are selected explicitly.",
    args: {...pageArgs(), search:{type:GraphQLString}, state:{type:new GraphQLList(nonNull(GraphQLString))}},
    resolve: async (_root, args, context) => {
      const first = Math.min(100, Math.max(1, args.first ?? 20));
      const where = and(args.ids?.length ? inArray(graphBatches.id,args.ids) : undefined, args.state?.length ? inArray(graphBatches.state,args.state) : undefined, args.search ? like(graphBatches.title, `%${args.search}%`) : undefined);
      const rows = await context.db().select().from(graphBatches).where(and(where,args.after ? gt(graphBatches.id,args.after) : undefined)).orderBy(asc(graphBatches.id)).limit(first+1);
      const nodes = await Promise.all(rows.slice(0,first).map(async row => {
        const counts = await context.db().select({state:graphBatchOperations.state,n:sql<number>`count(*)`}).from(graphBatchOperations).where(and(eq(graphBatchOperations.batchId,row.id),sql`${graphBatchOperations.state} <> 'removed'`)).groupBy(graphBatchOperations.state);
        return {...row,counts:Object.fromEntries(counts.map(count => [count.state,Number(count.n)]))};
      }));
      const [total] = await context.db().select({n:sql<number>`count(*)`}).from(graphBatches).where(where);
      return {nodes,pageInfo:{hasNextPage:rows.length>first,endCursor:rows.length>first ? nodes.at(-1)?.id : null},aggregate:{count:Number(total.n)}};
    },
  },
  changeBatch: {
    type: ChangeBatch, description: "One change batch, with every operation and its state; null when there is none.",
    args: { id: { type: nonNull(GraphQLID) } },
    resolve: (_root, { id }: { id: string }, context) => getBatch(context.db(), context.identity, { batchId: id })
      .then(view, (error: unknown) => (error instanceof Response && error.status === 404 ? null : Promise.reject(error))),
  },
};

const Mutation = new GraphQLObjectType<unknown, MutationContext>({
  name: "Mutation",
  fields: {
    ...documentMutations,
    reviewBatch: mutationField({name:"ReviewBatch",description:"Approve or reject submitted changes as an editor: the member in the Wiki, or the member's own agent connection acting with the member's identity. Apps and delegated writers cannot review.",input:batchReviewInput,output:nonNull(ChangeBatch),
      run: async (context: MutationContext,input) => view(await reviewBatch(context.db(),context.identity,context.actor,context.originActor,input))}),
    stageChanges: mutationField({
      name: "StageChanges", output: nonNull(ChangeBatch),
      description: "Stage up to 100 proposals, opening a batch a member reviews when batchId is omitted; a batch that commits by policy (Forerunner's) takes proposals only from whoever opened it. Each proposal is one graph.apply operation with evidence citations, confidence (0-1) and a short reason: {\"operation\":{\"operation\":\"create\",\"ref\":\"$ada\",\"type\":\"graph-node\",\"attributes\":{\"typeId\":\"<Person type id>\",\"title\":\"Ada\"}},\"evidence\":[{\"provider\":\"gmail\",\"recordId\":\"<account email>/<message id>\",\"quote\":\"...\"}],\"reason\":\"...\"}. An update names id and revision; an edge's fromId and toId may be refs staged earlier in the batch. Re-adding an identical proposal does nothing; a ref already used for another is a conflict.",
      input: stageInput,
      run: async (context: MutationContext, input) => {
        const db = context.db();
        const batchId = input.batchId ?? (await openBatch(db, context.identity, context.actor, { title: input.title ?? "", purpose: input.purpose ?? "", ...(input.source ? { source: input.source } : {}), policy: { kind: "member" } })).batch.id;
        await addToBatch(db, context.identity, context.actor, { batchId, proposals: input.proposals });
        return view(await getBatch(db, context.identity, { batchId }));
      },
    }),
    removeStagedChanges: mutationField({
      name: "RemoveStagedChanges", output: nonNull(ChangeBatch), description: "Remove proposals from an open batch by ref.",
      input: batchRemoveInput,
      run: async (context: MutationContext, input) => {
        return view(await removeFromBatch(context.db(), context.identity, context.actor, input));
      },
    }),
    submitBatch: mutationField({
      name: "SubmitBatch", output: nonNull(ChangeBatch),
      description: "Submit an open batch for a member's review on the Changes page. Refused, naming the problem, while an operation would not apply; the batch stays open to fix. The ontology steward then reviews it in the background and attaches advisory findings (review, empty until it finishes); its policy decides exactly as without them.",
      input: batchSubmitInput,
      run: async (context: MutationContext, input) => {
        const db = context.db();
        await submitBatch(db, context.identity, context.actor, input);
        context.afterSubmit?.(input.batchId);
        return view(await getBatch(db, context.identity, { batchId: input.batchId }));
      },
    }),
  },
});

const baseGraphqlSchema = new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: changeQueries }), mutation: Mutation });

export const graphqlSchema = batchSchema(baseGraphqlSchema, batchGroups);
