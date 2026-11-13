import { and, asc, eq, inArray, like, sql, gt } from "drizzle-orm";
import { graphBatches, graphBatchOperations } from "./schema";
import { connectionType, pageArgs } from "@ai-outfitter/app-sdk/app-graphql";
import { instructionType, resultInstructions } from "@ai-outfitter/app-sdk/batch-documents";
import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
// The Wiki's change batches over GraphQL, for agents. Agents stage proposed records with
// the mutation documents (documents.ts) and a member commits them on the Changes page
// (batch.review stays a member's step there). graph.mutate runs graphqlSchema; the
// Wiki's graph.graphql serves changeQueries beside its generated types, so the
// printed schema (graph/schema.graphql) answers through both.
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { mutationField } from "@ai-outfitter/app-sdk/app-graphql";
import { DateTimeScalar, JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import type { PullRequestHost } from "@ai-outfitter/app-sdk/github-pulls";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import {
  GraphQLBoolean, type GraphQLFieldConfig, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType,
  GraphQLSchema, GraphQLString,
} from "graphql";
import { z } from "zod";
import { explorationArgs, pictureProviders, listExplorations, mutateExploration, mutateExplorationInput, readExploration } from "./explorations";
import { readGraph, withRecordAddresses } from "./graph";
import { listShares, mutateShareInput, mutateShare, readShare, shareSlug, sharesFor } from "./graph-shares";
import { recordAddress } from "../lib/addresses";
import { addToBatch, batchAddInput, batchOpenInput, batchRemoveInput, batchSource, batchSubmitInput, getBatch, openBatch, removeFromBatch, submitBatch, reviewBatch, batchReviewInput, batchConfigureInput, configureBatch, validateBatch, batchReviseInput, reviseBatch } from "./graph-batches";

/** What graph.graphql passes to these resolvers; graph.mutate passes the whole action context. */
export type ChangeContext = { identity: AppIdentity; db: () => ReturnType<typeof installationDatabase>;
  /** The workflow host, for live reads an exploration opens (pull requests); absent where there is none. */
  host?: () => PullRequestHost;
  /** Starts the ontology steward's review of a submitted batch in the background (graph.mutate only). */
  afterSubmit?: (batchId: string) => void };
type MutationContext = ChangeContext & ActionContext;

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
const text = { type: nonNull(GraphQLString) };
/** The batch's review page, relative to this installation; the platform resolves it against the install's mount. */
export const batchReviewUrl = (batchId: string) => `changes/${encodeURIComponent(batchId)}`;
const json = { type: nonNull(JSONScalar) };

const StagedChange = new GraphQLObjectType({
  name: "StagedChange", description: "One proposed graph.apply operation in a batch.",
  fields: {
    ref: text,
    state: { ...text, description: "pending, awaiting_review, committed or rejected." },
    operation: json, evidence: json,
    confidence: { type: GraphQLFloat }, reason: { type: GraphQLString },
    decision: { type: JSONScalar, description: "Who or which policy decided it, and when." },
    record: { type: GraphQLString, description: "The committed record's address: Person, Organization:sunny or works_on(Person:ada → Project:sunny)." },
    recordRevision: { type: GraphQLInt },
  },
});
// validation and instructions both need the dry run; run it once per resolved batch.
const validations = new WeakMap<object, ReturnType<typeof validateBatch>>();
const batchValidation = (batch: { id: string }, context: ChangeContext) => {
  if (!validations.has(batch)) validations.set(batch, validateBatch(context.db(), context.identity, { batchId: batch.id }));
  return validations.get(batch)!;
};
const ChangeBatch = new GraphQLObjectType({
  name: "ChangeBatch", description: "Proposed Wiki changes, invisible to every read until a member commits them on the Changes page.",
  fields: {
    id: { type: nonNull(GraphQLID) }, title: text, purpose: text,
    state: { ...text, description: "open, awaiting_review, committed, rejected or discarded." },
    source: { type: JSONScalar }, createdAt: { type: nonNull(DateTimeScalar) },
    anchors: { type: nonNull(new GraphQLList(nonNull(GraphQLString))), description: "Anchor node addresses; every created node must connect to one.", resolve: async (batch, _args, context: ChangeContext) => {
      const graph = await readGraph(context.db(), context.identity);
      const address = recordAddress(graph);
      return (batch.anchors ?? []).flatMap((id: string) => address("graph-node", id) ?? []);
    } },
    validation: { type: nonNull(JSONScalar), description: "Current dry-run result: valid, error and operations. valid=false means repair the draft before submitting; nothing has been applied.", resolve: (batch, _args, context: ChangeContext) => batchValidation(batch, context) },
    policy: json, summary: { type: JSONScalar },
    reviewBy: { type: DateTimeScalar },
    reviewUrl: { type: GraphQLString, description: "The review page, relative to this installation (the platform returns it as a full link).", resolve: (batch) => batchReviewUrl(batch.id) },
    review: { type: JSONScalar, description: "The ontology steward's latest advisory review: state, findings by operation ref, coverage, prompt digest and its batch-review workflow run, whose logs are the audit trail. It never approves or blocks anything." },
    expiresAt: { type: nonNull(DateTimeScalar) }, updatedAt: { type: nonNull(DateTimeScalar) },
    counts: { ...json, description: "Operations by state." },
    instructions: { type: nonNull(new GraphQLList(nonNull(instructionType))), resolve: async (batch, _args, context: ChangeContext) => resultInstructions(batch.id, { ...batch, validation: await batchValidation(batch, context) }, batchReviewUrl(batch.id)) },
    operations: {
      type: nonNull(new GraphQLList(nonNull(StagedChange))),
      args: { refs: { type: new GraphQLList(nonNull(GraphQLString)), description: "Read only these proposal refs; omit for all. Use to inspect individual proposals when the whole batch exceeds the response limit." } },
      resolve: async (batch, { refs }: { refs?: string[] | null }, context: ChangeContext) => {
        const operations = batch.operations ?? (await getBatch(context.db(), context.identity, {batchId:batch.id})).operations;
        const chosen = refs ? operations.filter((operation: {ref:string}) => refs.includes(operation.ref)) : operations;
        return withRecordAddresses(context.db(), chosen);
      },
    },
  },
});

const ExplorationNode = new GraphQLObjectType({
  name: "ExplorationNode", description: "A record in an exploration's picture.",
  fields: { key: { ...text, description: "<Type>:<slug> (Onto's node address); steps, hidden and focus name nodes by it." }, type: text, title: text, slug: { type: GraphQLString },
    id: { type: nonNull(GraphQLID) }, step: { type: GraphQLString, description: "The step that added it; null for the start." },
    url: { type: GraphQLString, description: "Its website; a pull request's GitHub page." },
    proposedIn: { type: GraphQLID, description: "The change batch proposing it; set only for staged records a member has not committed (key proposed:<batch>/<ref>)." } },
});
const ExplorationEdge = new GraphQLObjectType({ name: "ExplorationEdge", description: "A relationship between two nodes in the picture.", fields: { from: text, to: text, label: text } });
const ExplorationStepResult = new GraphQLObjectType({
  name: "ExplorationStepResult", description: "What one step reached.",
  fields: { key: text, count: { type: nonNull(GraphQLInt) }, truncated: { type: nonNull(GraphQLBoolean), description: "The step's limit cut it." }, error: { type: GraphQLString } },
});
const ExplorationPicture = new GraphQLObjectType({
  name: "ExplorationPicture", description: "The nodes and relationships an exploration's steps reach now, rebuilt on every read.",
  fields: { nodes: { type: nonNull(new GraphQLList(nonNull(ExplorationNode))) }, edges: { type: nonNull(new GraphQLList(nonNull(ExplorationEdge))) },
    steps: { type: nonNull(new GraphQLList(nonNull(ExplorationStepResult))) }, truncated: { type: nonNull(GraphQLBoolean), description: "The picture reached its 300-node limit." } },
});
const Exploration = new GraphQLObjectType({
  name: "Exploration", description: "A saved view of this Wiki's graph that members and agents change together. It stores steps, never facts.",
  fields: {
    slug: text, title: text, revision: { type: nonNull(GraphQLInt), description: "Send it as expectedRevision with the next patch." },
    state: { ...json, description: "{title, start: {type, slug}, steps: {<key>: {from, path, direction?, limit?, type?}}, hidden: {<node key>: true}, focus?, direction?}; patch it with MutateExploration." },
    lastChange: { type: JSONScalar, description: "{by, via, summary, nodes}: the latest change and the node keys it added." },
    picture: { type: nonNull(ExplorationPicture) },
    dryRun: { type: GraphQLBoolean },
  },
});
const ShareNode = new GraphQLObjectType({ name: "ShareNode", fields: { address: text, title: text, summary: { type: GraphQLString } } });
const ShareEdge = new GraphQLObjectType({ name: "ShareEdge", fields: { address: text } });
const ShareView = new GraphQLObjectType({
  name: "ShareView", description: "What the organization reads now: current records the KnowledgeGraph reaches from the roots, without hidden nodes.",
  fields: { nodes: { type: nonNull(new GraphQLList(nonNull(ShareNode))) }, edges: { type: nonNull(new GraphQLList(nonNull(ShareEdge))) }, incomplete: { type: nonNull(GraphQLBoolean), description: "The KnowledgeGraph's maxNodes or read budget cut the walk." } },
});
const Share = new GraphQLObjectType({
  name: "Share", description: "What this graph shows another organization: a saved KnowledgeGraph walked from roots, minus hidden nodes. It holds a selection, never a copy.",
  fields: {
    slug: text, title: text, revision: { type: nonNull(GraphQLInt) }, archived: { type: nonNull(GraphQLBoolean) },
    organization: { ...text, description: "The Organization node it is for, such as Organization:sunny." },
    graph: { ...text, description: "The KnowledgeGraph that picks relationships, types and depth." },
    roots: { ...json, description: "{\"Type:slug\": true} the walk starts from." },
    hidden: { ...json, description: "{\"Type:slug\": true} left out, with anything reached only through them." },
    view: { type: ShareView, description: "Null while archived." },
  },
});
const ExplorationSummary = new GraphQLObjectType({ name: "ExplorationSummary", fields: { slug: text, title: text, revision: { type: nonNull(GraphQLInt) }, start: json } });

type Batch = Awaited<ReturnType<typeof getBatch>>;
const view = ({ batch, counts, operations }: Batch) => ({ ...batch, counts, operations });

export const stageInput = z.strictObject({
  batchId: z.uuid().optional().describe("Add to this open batch; omit to open one."),
  title: z.string().min(1).max(200).optional().describe("Names the batch a new one opens with."),
  purpose: z.string().max(2000).optional(),
  source: batchSource.optional().describe("Where the proposals came from, for a new batch: {kind: \"agent-task\" | \"meeting\" | \"import\" | \"work-package\", ref, label?}, e.g. a chat or meeting ID and its title."),
  anchors: batchOpenInput.shape.anchors,
  proposals: batchAddInput.shape.proposals,
  replace: batchAddInput.shape.replace,
}).refine(input => input.batchId || input.title, { message: "Pass batchId, or a title to open a batch", path: ["title"] });

export const changeQueries: Record<string, GraphQLFieldConfig<unknown, ChangeContext>> = {
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
  explorations: {
    type: nonNull(new GraphQLList(nonNull(ExplorationSummary))), description: "Saved explorations in this Wiki, by title.",
    resolve: (_root, _args, context) => listExplorations(context.db()),
  },
  exploration: {
    type: Exploration, description: "One exploration and its picture, rebuilt from current records; null when there is none.",
    args: { slug: { type: nonNull(GraphQLString) } },
    resolve: (_root, args, context) => readExploration(context.db(), explorationArgs.parse(args).slug, pictureProviders(context.db(), context.host)),
  },
  shares: {
    type: nonNull(new GraphQLList(nonNull(Share))), description: "What this graph shows other organizations, by title. Select view to see what each one reads.",
    resolve: async (_root, _args, context) => listShares(context.db()),
  },
  share: {
    type: Share, description: "One share and what its organization reads now; null when there is none.",
    args: { slug: { type: nonNull(GraphQLString) } },
    resolve: (_root, args, context) => readShare(context.db(), context.identity, shareSlug.parse(args.slug)),
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
    reviseBatch: mutationField({
      name: "ReviseBatch", output: nonNull(ChangeBatch), input: batchReviseInput,
      description: "Amend undecided proposals by ref, add proposals or withdraw refs in an open or submitted member-review batch. Keeps the batch pending review, preserves decisions and commits no graph records. Requires the member's own editor connection; apps and delegated writers cannot amend.",
      run: async (context: MutationContext, input) => {
        const revised = await reviseBatch(context.db(), context.identity, context.actor, context.originActor, input);
        if (revised.batch.state === "awaiting_review") context.afterSubmit?.(input.batchId);
        return view(revised);
      },
    }),
    mutateExploration: mutationField({
      name: "MutateExploration", output: nonNull(Exploration),
      description: "Change what an exploration shows with a merge patch over its state and the revision you read: open a path from a node (steps), hide nodes, or start a new one at expectedRevision 0. Named paths: offerings, products, projects, competitors, issues, repositories, pullRequests (live from GitHub; state open by default); any Wiki edge type name also works. It writes no records: to add a record, stage a change batch. Answers with the new picture.",
      input: mutateExplorationInput,
      run: (context: MutationContext, input) => mutateExploration(context.db(), context.identity, context.actor, input, pictureProviders(context.db(), context.host)),
    }),
    mutateShare: mutationField({
      name: "MutateShare", output: nonNull(Share),
      description: "Editors only. Create or change what this graph shows another organization with a merge patch over {title, organization, graph, roots, hidden} and the revision you read (0 creates). organization is an Organization node address, graph a KnowledgeGraph address whose relationships, stop types and maxDepth decide what is reached, roots and hidden are {\"Type:slug\": true}. archived:true stops it. Answers with what the organization would read.",
      input: mutateShareInput,
      run: async (context: MutationContext, input) => {
        const share = await mutateShare(context.db(), context.identity, input);
        return readShare(context.db(), context.identity, share.slug);
      },
    }),
    reviewBatch: mutationField({name:"ReviewBatch",description:"Approve or reject submitted changes as an editor: the member in the Wiki, or the member's own agent connection acting with the member's identity. Apps and delegated writers cannot review.",input:batchReviewInput,output:nonNull(ChangeBatch),
      run: async (context: MutationContext,input) => view(await reviewBatch(context.db(),context.identity,context.actor,context.originActor,input))}),
    stageChanges: mutationField({
      name: "StageChanges", output: nonNull(ChangeBatch),
      description: "Stage up to 100 proposals, opening a batch a member reviews when batchId is omitted; a batch that commits by policy (Forerunner's) takes proposals only from whoever opened it. Each proposal is one graph.apply operation with evidence citations, confidence (0-1) and a short reason: {\"operation\":{\"operation\":\"create\",\"ref\":\"$ada\",\"type\":\"graph-node\",\"attributes\":{\"typeId\":\"Person\",\"title\":\"Ada\"}},\"evidence\":[{\"provider\":\"gmail\",\"recordId\":\"<account email>/<message id>\",\"quote\":\"...\"}],\"reason\":\"...\"}. Name existing records by address: typeId takes a type name (Person), fromId and toId take node addresses (Organization:sunny) or refs staged earlier in the batch, and an update names its record (Person, Organization:sunny or works_on(Person:ada → Project:sunny), with @<validFrom> when the edge has a start) as id with its revision. A new batch is anchored to the root (the organization's Organization node, or the owner's Person in a personal graph): every new node must connect to it. Pass anchors (node addresses) only when the member asks for a narrower scope; [] removes the requirement. Re-adding an identical proposal does nothing; a ref already used for another is a conflict unless replace:true explicitly replaces it, including evidence and reason. Read validation in the result and repair until valid before submitting.",
      input: stageInput,
      run: async (context: MutationContext, input) => {
        const db = context.db();
        const batchId = input.batchId ?? (await openBatch(db, context.identity, context.actor, { title: input.title ?? "", purpose: input.purpose ?? "", ...(input.source ? { source: input.source } : {}), ...(input.anchors ? { anchors: input.anchors } : {}), policy: { kind: "member" } })).batch.id;
        if (input.batchId && input.anchors) await configureBatch(db, context.identity, context.actor, { batchId, anchors: input.anchors });
        await addToBatch(db, context.identity, context.actor, { batchId, proposals: input.proposals, replace: input.replace });
        return view(await getBatch(db, context.identity, { batchId }));
      },
    }),
    configureBatch: mutationField({
      name: "ConfigureBatch", output: nonNull(ChangeBatch), description: "Replace anchor nodes of an open batch or an undecided batch awaiting member review. Submitted proposals must already connect to the selected anchors. Empty anchors removes the connectivity requirement. Returns current validation without applying any records.", input: batchConfigureInput,
      run: async (context: MutationContext, input) => view(await configureBatch(context.db(), context.identity, context.actor, input)),
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

/** All a member of another organization can ask: the shares made for their organization. */
export const externalSchema = new GraphQLSchema({ query: new GraphQLObjectType<unknown, ChangeContext>({ name: "Query", fields: {
  shares: { type: nonNull(new GraphQLList(nonNull(Share))), description: "What this graph shares with your organization.", resolve: (_root, _args, context) => sharesFor(context.db(), context.identity) },
  share: { type: Share, description: "One share made for your organization; null when there is none.", args: { slug: { type: nonNull(GraphQLString) } },
    resolve: async (_root, args, context) => (await sharesFor(context.db(), context.identity, shareSlug.parse(args.slug)))[0] ?? null },
} }) });

const baseGraphqlSchema = new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: changeQueries }), mutation: Mutation });

export const graphqlSchema = batchSchema(baseGraphqlSchema, batchGroups);
