import {submitReleaseEvidence,submitReleaseEvidenceInput} from "./release-evidence";
import { submitRequest, requestInput, readRequests, requestReadInput, requestDescriptionText } from "./requests";
import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { fieldError, mutationField, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import { DateTimeScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { inArray, sql } from "drizzle-orm";
import {
  GraphQLBoolean, type GraphQLFieldConfig, type GraphQLFieldResolver, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType,
  GraphQLObjectType, GraphQLSchema, GraphQLString, getNamedType,
} from "graphql";
import { readChanges } from "./github/changes";
import type { IntakeContext } from "./intake";
import { requireAvailable, userGithub } from "./pages";
import { createProject, createProjectInput } from "./projects";
import { enableRepository, enableRepositoryInput } from "./repositories";
import { foundryProjects, workSubmissions } from "./schema";

type Caller = TableContext & ActionContext & { host: () => WorkflowHost<"interactive">; repositories?: Promise<string[]>; readable?: string[] };
/** What the actions route (and a page running a document in process) passes to every resolver. */
export type FoundryContext = IntakeContext & TableContext;

// Submitted work, without the submitted payload (description, criteria, work package)
// or its digest. Each read is narrowed to the repositories the caller may read now.
const work = tableType(workSubmissions, {
  field: "work", type: "Work",
  fields: ["requestId", "repository", "issue", "createdAt"],
  dates: ["createdAt"],
  filters: ["repository", "requestId"],
  scope: (context) => {
    const { readable } = context as Caller;
    return readable?.length ? inArray(sql`lower(${workSubmissions.repository})`, readable) : undefined;
  },
});
// Those repositories are the ones work.get admits: in exactly one of the caller's GitHub or Forgejo
// connections (lower case in the snapshot). They are looked up once per request, and only
// when work is read.
const resolveWork = work.work.resolve as GraphQLFieldResolver<unknown, TableContext>;
work.work.resolve = async (source, args, context, info) => {
  const caller = context as Caller;
  caller.repositories ??= caller.host().call("snapshot", {}).then(({ connections }) => {
    const names = connections.filter((connection) => ["github", "forgejo"].includes(connection.provider))
      .flatMap((connection) => connection.repositories.map((name) => name.toLowerCase()));
    return names.filter((name) => names.indexOf(name) === names.lastIndexOf(name));
  });
  caller.readable = await caller.repositories;
  return resolveWork(source, args, context, info);
};

const projects = tableType(foundryProjects, {
  field: "foundryProjects", type: "FoundryProject",
  fields: ["name", "position", "repositories", "milestones", "revision", "updatedAt"],
  dates: ["updatedAt"],
});

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
const stringList = () => nonNull(new GraphQLList(nonNull(GraphQLString)));

// What shipped: pull requests merged into the caller's GitHub repositories, read live
// from GitHub through the caller's own connection (nothing is stored), so each read
// sees exactly the repositories that connection may read now.
const DAY = 86_400_000;
const withOffset = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const change = new GraphQLObjectType({ name: "Change", description: "One pull request merged into a repository.", fields: {
  repository: { type: nonNull(GraphQLString) }, number: { type: nonNull(GraphQLInt) }, title: { type: nonNull(GraphQLString) },
  url: { type: nonNull(GraphQLString) }, mergedAt: { type: nonNull(DateTimeScalar) },
  author: { type: GraphQLString, description: "GitHub login; null for a deleted account." },
  mergeCommit: { type: GraphQLString, description: "The commit the merge put on the base branch." },
  kind: { type: GraphQLString, description: "feature, fix or maintenance from a Conventional Commits title prefix (feat:, fix:, or build, chore, ci, deps, docs, perf, refactor, revert, style, test); null otherwise, so classify it yourself." },
  areas: { type: stringList(), description: "Parts of the repository the change touched: each file's first directory, or for a file under apps/ or packages/, that package (catalog/apps/crm). \".\" is the root. Read from the first 100 files." },
} });
const changeList = new GraphQLObjectType({ name: "ChangeList", fields: {
  changes: { type: nonNull(new GraphQLList(nonNull(change))), description: "Newest merge first." },
  failed: { type: stringList(), description: "Repositories GitHub did not answer in full; their changes may be missing or partial." },
  complete: { type: nonNull(GraphQLBoolean), description: "False when a repository had more than 250 merges in the window; narrow it." },
} });
const changes: Record<"changes", GraphQLFieldConfig<unknown, FoundryContext>> = { changes: {
  type: nonNull(changeList),
  description: "Pull requests merged at or after `since` and before `until` (default now; both ISO-8601 with an offset), at most 31 days apart, across `repositories` (owner/name) or, by default, every repository your GitHub connection may read.",
  args: { since: { type: nonNull(DateTimeScalar) }, until: { type: DateTimeScalar }, repositories: { type: new GraphQLList(nonNull(GraphQLString)) } },
  resolve: async (_source, args: { since: string; until?: string | null; repositories?: string[] | null }, context) => {
    try {
      // An instant without an offset would be read in the server's time zone.
      const until = args.until ?? new Date().toISOString();
      const span = Date.parse(until) - Date.parse(args.since);
      if (![args.since, until].every((time) => withOffset.test(time)) || !(span > 0 && span <= 31 * DAY))
        throw new Response("`since` and `until` are ISO-8601 date-times with an offset (Z or ±hh:mm), `since` first, at most 31 days apart.", { status: 400 });
      const github = await userGithub((context as Caller).host());
      const requested = [...new Set(args.repositories?.map((name) => name.toLowerCase()) ?? github.names)];
      requireAvailable(github, requested);
      return await readChanges(github.graphql, requested, args.since, until);
    } catch (error) {
      throw await fieldError(error);
    }
  },
} };
/** The row type a tableType collection pages (`<Type>Connection.nodes`), so a mutation returns the same record a read does. */
const rowType = (collection: GraphQLFieldConfig<unknown, TableContext>) =>
  getNamedType((getNamedType(collection.type) as GraphQLObjectType).getFields().nodes.type) as GraphQLObjectType;

// work.submit's result, typed so a document selects what it needs and gql.tada types it.
const submittedIssue = new GraphQLObjectType({ name: "SubmittedIssue", fields: {
  number: { type: nonNull(GraphQLInt) }, url: { type: nonNull(GraphQLString) },
  created: { type: nonNull(GraphQLBoolean), description: "False when a retry found the issue (or comment) an earlier attempt wrote, or an existing issue was attached." },
} });
const workRun = new GraphQLObjectType({ name: "WorkRun", description: "The issue's Foundry run; `existing` when it was already running or recorded, so nothing was restarted.", fields: {
  id: { type: nonNull(GraphQLID) }, workflow: { type: nonNull(GraphQLString) }, existing: { type: nonNull(GraphQLBoolean) },
  status: { type: nonNull(GraphQLString) }, url: { type: nonNull(GraphQLString) },
} });
const workExecution = new GraphQLObjectType({ name: "WorkExecution", description: "Why no run is reported although the issue is recorded: execution is blocked, or its outcome is unknown and must be reconciled.", fields: {
  status: { type: nonNull(GraphQLString) }, message: { type: nonNull(GraphQLString) },
} });
const submissionFields = {
  submissionId: { type: nonNull(GraphQLID), description: "Read it back with work.get." },
  repository: { type: nonNull(GraphQLString) },
  issue: { type: nonNull(submittedIssue) },
  run: { type: workRun },
  execution: { type: workExecution },
};
const submittedRequest = new GraphQLObjectType({ name: "SubmittedRequest", description: "The request's GitHub issue and the Foundry run working it.", fields: {
  id: { type: nonNull(GraphQLID) }, kind: { type: nonNull(GraphQLString) },
  ...submissionFields,
} });

const enabledRepository = new GraphQLObjectType({ name: "EnabledRepository", description: "The repository's Foundry subscription.", fields: {
  repository: { type: nonNull(GraphQLString) }, subscriptionId: { type: nonNull(GraphQLID) }, workflow: { type: nonNull(GraphQLString) },
} });

// Foundry's writes. graph.mutate admits editors (mutateAction's default). Variables travel
// within the SDK's 32 KiB limit: Planning sends larger submissions (a frozen work package)
// to the work.submit action.
const mutation = new GraphQLObjectType<unknown, FoundryContext>({
  name: "Mutation",
  fields: {
    submitReleaseEvidence:mutationField<typeof submitReleaseEvidenceInput,FoundryContext>({name:"SubmitReleaseEvidence",description:"Reserve expiring authenticated PUT links for immutable release evidence assets. Uploads verify size, digest and file type. Repeat the same keys to read completion receipts. This never approves or deploys a release.",input:submitReleaseEvidenceInput,run:submitReleaseEvidence}),
    submitRequest: mutationField<typeof requestInput, FoundryContext>({
      name: "SubmitRequest", description: requestDescriptionText, input: requestInput, output: nonNull(submittedRequest),
      run: submitRequest,
    }),
    enableRepository: mutationField<typeof enableRepositoryInput, FoundryContext>({
      name: "EnableRepository",
      description: "Turn Foundry execution on for a repository this organization's GitHub connection reaches: approve its role agents and subscribe to its issues, so requests filed there start Foundry's issue-to-merge workflow. Repeat after a Foundry change to refresh. Owners and admins only.",
      input: enableRepositoryInput, output: nonNull(enabledRepository),
      run: enableRepository,
    }),
    createProject: mutationField<typeof createProjectInput, FoundryContext>({
      name: "CreateProject",
      description: "Add a Foundry project: a named group of repositories work can be routed to, at the lowest priority. Names are upper case and unique; repositories lower case, once each. Owners and admins only.",
      input: createProjectInput, output: nonNull(rowType(projects.foundryProjects)),
      run: (context, input) => createProject(context.db(), context.identity, input),
    }),
  },
});

/** What Foundry serves over graph.graphql and graph.mutate (printed to graph/schema.graphql
 * by scripts/graph-schema.ts): its projects, which every member reads, submitted work, what
 * shipped (merged pull requests, read live from GitHub), and
 * the writes its documents (src/server/documents.ts) run. */
const baseGraphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: "Query", fields: { ...work, ...projects, ...changes } }),
  mutation,
});

const requestQuery = baseGraphqlSchema.getQueryType()!;
const requestSchema = new GraphQLSchema({...baseGraphqlSchema.toConfig(),types:baseGraphqlSchema.toConfig().types.filter(type=>type!==requestQuery),query:new GraphQLObjectType({...requestQuery.toConfig(),fields:{...requestQuery.toConfig().fields,requests:mutationField({name:"Requests",description:"Read your feature and bug requests with their GitHub issues.",input:requestReadInput,run:readRequests})}})});
export const graphqlSchema = batchSchema(requestSchema, batchGroups);
