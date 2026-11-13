import { dailyReportReadInput, readDailyReport } from "./digest-wiki";
import { dailyReportsInput, startDailyReports } from "./digests";
import { readOrder, saveOrder, orderInput, sortByOrder } from "./priority-order";
import { personalPortfolio, portfolioOrderInput, reorderPersonalPortfolio } from "./personal-portfolio";
import { connectionType, fieldError, idList, mutationField, type PageArgs, page, pageArgs, pageStart, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import { batchSchema, readBatchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { DateTimeScalar, JSONScalar } from "@ai-outfitter/app-sdk/graph-graphql";
import { and, asc, count, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";
import {
  GraphQLError, GraphQLBoolean, GraphQLEnumType, type GraphQLFieldConfig, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType,
  GraphQLSchema, GraphQLString, getNamedType,
} from "graphql";
import { z } from "zod";
import { productReportRuns, productReportSchedule, productReportScheduleInput, changeProductReportSchedule, startProductReport, productReportInput } from "./product-report-workflow";
import { readProductPage, productPageMarkdown } from "./product-page-data";
import { batchGroups, readGroups } from "./batch-groups";
import { linkChangesInput, linkProjectChanges } from "./code-changes";
import { metricMeasurementsInput, readMetricMeasurements, recordMeasurements, recordMeasurementsInput } from "./measurements";
import { createWithRequirements, deliveryResult, latestPreparation, loadRequirements, preparationSummary, prepareInput, prepareProject, saveProjectChange } from "./delivery";
import { deliveryInput, projectDelivery, submitDeliveryPackage, submitPackageInput } from "./delivery-read";
import { changeDigestSchedule, digestListInput, digestRuns, digestSchedule, digestScheduleInput, generateDigestInput, listDigests, startDigest } from "./digests";
import { issueFields as issueInput, projectFields } from "./fields";
import {
  releaseFitInput, setIntakeReleaseFit, claimInput, claimWork, createIntake, type IntakeRow, IntakeService, intakeInput, type PlanningContext, previewIntakeInput, previewIntakeWork, publishResult,
  recordResult, recordResultInput, resetSubmission, resetSubmissionInput, reviseScope, reviseScopeInput, routeInput, routeIntake, saveDraftInput,
  saveResultDraft, selection, submitIntakeInput, submitIntakeWork,
} from "./intake";
import { type OrganizationGoals, readOrganizationGoals } from "./organization-goals";
import { archiveProject, archiveProjectInput, projectStateInput, setProjectState, createIssue, deleteIssue, deleteProject, patchProjectInput, reorderInput, reorderIssues, revisionField, updateIssue, updateProject, patchProject as patchProjectRecord } from "./planning";
import { projectContext, projectReadiness, projectSlug } from "./project-context";
import {
  acceptPartnerRequest, acceptPartnerRequestInput, listPartnerRequests, partnerRequestInput, refreshDesignPartners, refreshPartnersInput,
  rejectPartnerRequest, rejectPartnerRequestInput, submitPartnerRequest,
} from "./partner-requests";
import { issues, projects } from "./schema";
import { listUseCases, saveUseCase, useCaseInput } from "./use-cases";
import { repositories, pullRequests } from "./project-repositories";
import { linkProjectNode, publishRepositories } from "./repository-patch";
import { githubRepositoryName } from "@ai-outfitter/app-sdk/github-pulls";
import { requireEditor } from "@ai-outfitter/app-sdk/server";

/** Issue states that make a project active. */
const open = ["todo", "in-progress"] as const;
/** What the actions route (and a page route running a document in process) passes to every resolver. */
type Context = PlanningContext & TableContext;

const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
/** The row type a tableType collection pages (`<Type>Connection.nodes`), so a mutation returns the same record a read does. */
const rowType = (collection: GraphQLFieldConfig<unknown, TableContext>) =>
  getNamedType((getNamedType(collection.type) as GraphQLObjectType).getFields().nodes.type) as GraphQLObjectType;

const issueFields = tableType(issues, {
  field: "issues", type: "Issue",
  fields: ["projectId", "parentId", "title", "description", "category", "status", "assigneeId", "dueDate", "position", "revision", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["projectId", "parentId"],
  filters: ["projectId", "status", "category"],
  // Every Planning read keeps to the caller's installation.
  scope: context => eq(issues.installationId, context.identity.installationId),
});

type ProjectRow = typeof projects.$inferSelect & { openIssues: number };
const text = { type: nonNull(GraphQLString) };
const projectDocument = (description: string) => ({ ...text, description: `${description} (Markdown).` });
const contextRecord = new GraphQLObjectType({name:"ProjectContextRecord",fields:{
  id:{type:nonNull(GraphQLID)},title:text,summary:text,revision:{type:nonNull(GraphQLInt)},
}});
const readinessType = new GraphQLObjectType({ name: "ProjectReadiness", description: "How ready the project is to plan or implement, from its linked Wiki context.", fields: {
  stage: { type: nonNull(GraphQLString), description: "frame (no linked problem or people yet), plan (context identified, scope to fill in) or implement." },
  priority: { type: nonNull(GraphQLInt) },
  signals: { type: nonNull(new GraphQLList(nonNull(GraphQLString))) },
  missing: { type: nonNull(new GraphQLList(nonNull(GraphQLString))), description: "The decisions and context still needed before the work is ready." },
  priorityGaps: { type: nonNull(new GraphQLList(nonNull(GraphQLString))) },
} });
const contextFields = Object.fromEntries((["useCases","customerSegments","userStoryRecords","goalRecords"] as const).map(field=>[field,{
  type:nonNull(new GraphQLList(nonNull(contextRecord))),
  resolve:async(project:ProjectRow,_args:unknown,context:Context)=>(await projectContext(context,project.id))[field],
}]));
const pullRequestType = new GraphQLObjectType({ name: "GithubPullRequest", fields: {
  number: { type: nonNull(GraphQLInt) }, title: text, url: text, state: text,
  createdAt: text, updatedAt: text, closedAt: { type: GraphQLString }, mergedAt: { type: GraphQLString },
} });
const pullPageInfo = new GraphQLObjectType({ name: "GithubPullRequestPageInfo", fields: { endCursor: { type: GraphQLString }, hasNextPage: { type: nonNull(GraphQLBoolean) } } });
const pullConnection = new GraphQLObjectType({ name: "GithubPullRequestConnection", fields: { nodes: { type: nonNull(new GraphQLList(nonNull(pullRequestType))) }, pageInfo: { type: nonNull(pullPageInfo) } } });
const pullActivity = new GraphQLObjectType({ name: "GithubPullRequestActivity", fields: { pullRequests: { type: pullConnection }, error: { type: GraphQLString } } });
const repositoryType = new GraphQLObjectType<import("../project-readiness").ProjectRepository, Context>({ name: "ProjectRepository", fields: {
  id: { type: nonNull(GraphQLID), resolve: row => row.edgeId ?? row.nodeId }, nameWithOwner: { ...text, resolve: row => row.repository }, url: text,
  path: { type: GraphQLString }, ref: { type: GraphQLString },
  pullRequests: { type: pullConnection, args: { first: { type: GraphQLInt, defaultValue: 20 }, after: { type: GraphQLString } },
    resolve: (row, args: { first: number; after?: string | null }, context) => {
      if (args.first < 1 || args.first > 100) throw new GraphQLError("first must be between 1 and 100");
      return pullRequests(context, row, args.first, args.after);
    } },
  pullRequestActivity: { type: nonNull(pullActivity), args: { first: { type: GraphQLInt, defaultValue: 20 }, after: { type: GraphQLString } },
    resolve: async (row, args: { first: number; after?: string | null }, context) => {
      if (args.first < 1 || args.first > 100) throw new GraphQLError("first must be between 1 and 100");
      try { return { pullRequests: await pullRequests(context, row, args.first, args.after), error: null }; }
      catch (error) { return { pullRequests: null, error: error instanceof Error && error.message === "Connect GitHub in Plugins to read pull requests." ? error.message : "GitHub pull requests are unavailable for this repository." }; }
    } },
} });
const Project = new GraphQLObjectType<ProjectRow, Context>({
  name: "Project",
  fields: {
    id: { type: nonNull(GraphQLID) },
    name: text,
    archived: {type:nonNull(GraphQLBoolean)},
    rank: { type: GraphQLInt, resolve: async (row, _args, context) => { const order = await readOrder(context.db(), context.identity, "projects"); const index = order.items.indexOf(row.id); return index < 0 ? null : index; } },
    state: { ...text, description: "Project lifecycle: draft, backlog, active, completed or archived." },
    slug: {type:GraphQLString,resolve:(project,_args,context)=>projectSlug(context,project.id)},
    ...contextFields,
    readiness: { type: nonNull(readinessType), resolve: (project, _args, context) => projectReadiness(context, project.id) },
    githubRepository: { type: GraphQLString, resolve: project => project.githubRepository || null },
    repositoryChanges: { type: JSONScalar, description: "Repository publication status, receipt and retry instructions returned by patchProject." },
    projectNodeChanges: { type: JSONScalar, description: "Onto Project node link returned by patchProject: state (unchanged, linked or created), slug, or the error and retry instructions." },
    repositories: { type: nonNull(connectionType(repositoryType)), args: pageArgs(), resolve: async (project, args: PageArgs & { ids?: string[] | null }, context, info) => {
      const { first, start } = pageStart(args);
      const ids = idList(args.ids);
      const id = (row: { nodeId: string; edgeId?: string }) => row.edgeId ?? row.nodeId;
      const rows = (await repositories(context, project.id, project.githubRepository)).filter(row => !ids || ids.includes(id(row))).sort((a, b) => id(a).localeCompare(id(b)));
      return { ...page(context, info, rows.filter(row => !start || id(row) > start), id, first, start), aggregate: { count: rows.length } };
    } },
    goals: projectDocument("What the project must achieve"),
    userStories: projectDocument("Who it serves and what they need"),
    pressRelease: projectDocument("The draft press release announcing it"),
    demoInstructions: projectDocument("How to demonstrate it"),
    demoResults: projectDocument("What the demonstration showed"),
    revision: { type: nonNull(GraphQLInt), description: "Rises with each change; updateProject and deleteProject name the revision read." },
    requirements: { type: nonNull(JSONScalar), description: "Active and retired requirements with their stable keys, ids and revisions. Being listed does not mean approved, implemented or verified.",
      resolve: async (project, _args, context) => (await loadRequirements(context, project.id)).map((r) => ({ id: r.id, revision: r.revision, retired: r.retired, ...r.body })) },
    requirementChanges: { type: JSONScalar, description: "On a write: which requirements were added, changed, retired, or only described differently (not actionable)." },
    preparation: { type: JSONScalar, description: "The latest delivery preparation: state (queued, dispatched, dispatch_failed, running, prepared, blocked, superseded, failed), dispatchError, intake, packages, questions, conflicts and blockers.",
      resolve: async (project: ProjectRow & { preparation?: unknown }, _args, context) => project.preparation !== undefined ? project.preparation : preparationSummary(await latestPreparation(context, project.id)) },
    run: { type: JSONScalar, description: "On a write that started preparation: its task run (id, status); read it with TaskRuns." },
    instructions: { type: JSONScalar, description: "On a write: required next steps, such as retrying a failed dispatch." },
    openIssues: { type: nonNull(GraphQLInt), description: "Issues in todo or in-progress." },
    updatedAt: { type: nonNull(DateTimeScalar) },
  },
});

// An intake as stored (src/server/intake.ts), with its routed child work. Reading routes
// inspects the intake: each route's blocker says why it cannot proceed now.
const intakeGate = new GraphQLObjectType({ name: "IntakeGate", description: "The Governance control that gates the work.", fields: {
  installationId: text, controlId: { type: nonNull(GraphQLID) },
} });
const intakeClaim = new GraphQLObjectType({ name: "IntakeClaim", description: "Who holds the work and until when (epoch milliseconds).", fields: {
  principal: text, until: { type: nonNull(GraphQLFloat) },
} });
const intakeRoute = new GraphQLObjectType({ name: "IntakeRoute", fields: {
  id: { type: nonNull(GraphQLID) },
  revision: { type: nonNull(GraphQLInt), description: "Rises with each recorded result." },
  kind: { ...text, description: "research, architecture, prioritization, backlog or implementation." },
  dependsOn: { type: nonNull(new GraphQLList(nonNull(GraphQLString))), description: "Kinds whose approved results this work waits for." },
  rationale: text,
  gate: { type: intakeGate },
  blocker: { type: GraphQLString, description: "Why the work cannot proceed now; null when it is ready or its result awaits review." },
  claim: { type: intakeClaim },
  draft: { type: JSONScalar, description: "The claim holder's unsubmitted draft (savedAt, result); saveResultDraft replaces it, recordResult submits it." },
  result: { type: JSONScalar, description: "The recorded summary, sources, gaps and, by kind, disposition or architecture." },
  observedAt: { type: GraphQLString },
  gateReceipt: { type: JSONScalar, description: "Governance's receipt for the review request of the current result." },
  gateError: { type: GraphQLString },
  receipt: { type: JSONScalar, description: "The Foundry delivery once implementation was submitted." },
  submissionIntent: { type: JSONScalar },
  subject: { type: JSONScalar, description: "The Governance subject: ref, revision and digest of this work record." },
} });
type IntakeSource = IntakeRow & { routingError?: string };
const intake = new GraphQLObjectType<IntakeSource, Context>({ name: "Intake", fields: {
  id: { type: nonNull(GraphQLID), description: "The requestId it was created with." },
  revision: { type: nonNull(GraphQLInt) },
  projectId: { type: GraphQLID, resolve: row => row.body.projectId ?? null },
  kind: { ...text, resolve: row => row.body.input.kind },
  title: { ...text, resolve: row => row.body.input.title },
  description: { ...text, resolve: row => row.body.input.description },
  sourceUrls: { type: nonNull(new GraphQLList(nonNull(GraphQLString))), resolve: row => row.body.input.sourceUrls ?? [] },
  sources: { type: nonNull(JSONScalar), description: "Wiki records at the revisions the intake was scoped to.", resolve: row => row.body.input.sources },
  originatingMessage: { type: JSONScalar, description: "Caller-provided conversation provenance; grants no transcript access.", resolve: row => row.body.input.originatingMessage ?? null },
  releaseFit: { type: JSONScalar, description: "Persisted release disposition, existing Release revision, rationale and backlog status.", resolve: row => row.body.releaseFit ?? null },
  releaseFitHistory: { type: nonNull(JSONScalar), resolve: row => row.body.releaseFitHistory ?? [] },
  routes: { type: nonNull(new GraphQLList(nonNull(intakeRoute))), resolve: async (row, _args, context) => (await new IntakeService(context).inspect(row)).body.routes },
  routing: { type: JSONScalar, description: "The automatic routing run: runId and state (running, proposed, complete or failed)." , resolve: row => row.body.routing ?? null },
  routingError: { type: GraphQLString, description: "Set by createIntake when the saved intake could not be routed; route it later." },
} });

// A project's daily digest (src/server/digests.ts): what changed since the previous one.
const digest = new GraphQLObjectType({ name: "ProjectDigest", description: "What changed in a project since its previous digest.", fields: {
  id: { type: nonNull(GraphQLID) },
  projectId: { type: nonNull(GraphQLID) },
  trigger: { ...text, description: "manual (a member's click) or schedule (the morning run)." },
  since: { type: DateTimeScalar, description: "When the previous digest was taken; null for a project's first digest, which covers the last 24 hours." },
  createdAt: { type: nonNull(DateTimeScalar) },
  summary: { type: GraphQLString, description: "The AI narrative: a headline line, a blank line, then a few sentences. Null when inference was unavailable." },
  summaryError: { type: GraphQLString, description: "Why there is no summary, when there is none." },
  changes: { type: nonNull(JSONScalar), description: "shipped, started, added, reopened, edited and removed issues ({ id, title, category, status }, at most 20 each); counts (exact); changed project documents by label; delivery { submitted, accepted }; current priorities (in-progress first, then top open stones and pebbles); totals { open, inProgress, done }." },
} });
const digestScheduleType = new GraphQLObjectType({ name: "DigestSchedule", description: "The local morning report chain: organization projects at 03:00, personal overview at 04:00 by default.", fields: {
  enabled: { type: nonNull(GraphQLBoolean) },
  cron: {type:GraphQLString}, timezone:{type:GraphQLString},
  nextRunAt: { type: GraphQLFloat, description: "Epoch milliseconds; null when off." },
  lastRunAt: { type: GraphQLFloat },
  lastOutcome: { type: GraphQLString },
} });

/** One statement: the installation's projects left-joined to their open issues, grouped. */
function projectRows(context: Context, { ids, active, after, archived, states }: { ids?: string[] | null; active?: boolean | null; after?: string | null; archived?:boolean | null; states?: string[] | null }) {
  const openIssues = sql<number>`count(${issues.id})`.mapWith(Number);
  return context.db()
    .select({ ...getTableColumns(projects), openIssues })
    .from(projects)
    .leftJoin(issues, and(eq(issues.installationId, projects.installationId), eq(issues.projectId, projects.id), inArray(issues.status, [...open])))
    .where(and(eq(projects.installationId, context.identity.installationId), ids ? inArray(projects.id, ids) : undefined, archived == null ? undefined : eq(projects.archived,archived), states ? inArray(projects.state, states as (typeof projects.$inferSelect.state)[]) : undefined, after ? gt(projects.id, after) : undefined))
    .groupBy(projects.id)
    .having(active === true ? gt(openIssues, 0) : active === false ? eq(openIssues, 0) : undefined);
}
/** A project as the graph serves it, read back after a write. */
const savedProject = async (context: Context, id: string) => (await projectRows(context, { ids: [id] }))[0];

const goalMetric = new GraphQLObjectType({ name: "GoalMetric", description: "A metric definition that measures a goal (`measured_by`).", fields: {
  id: { type: nonNull(GraphQLID) }, title: text, summary: text,
} });
const organizationGoal = new GraphQLObjectType({ name: "OrganizationGoal", fields: {
  id: { type: nonNull(GraphQLID) }, title: text, summary: text, revision: { type: nonNull(GraphQLInt) },
  metrics: { type: nonNull(new GraphQLList(nonNull(goalMetric))), description: "The KPIs that measure this goal, by title." },
} });
const organizationGoals = new GraphQLObjectType<OrganizationGoals, Context>({
  name: "OrganizationGoals",
  description: "The organization's Wiki page (bound by its organization_id) with the goals it pursues and each goal's metrics.",
  fields: {
    id: { type: nonNull(GraphQLID), description: "The Wiki Organization page's id." },
    revision: { type: nonNull(GraphQLInt) },
    title: text, summary: text,
    goals: { type: nonNull(new GraphQLList(nonNull(organizationGoal))) },
    truncated: { type: nonNull(GraphQLBoolean), description: "The organization pursues more goals than the 20 listed." },
  },
});

const productReference = new GraphQLObjectType({name:"ProductReference", fields:{id:{type:nonNull(GraphQLID)},title:text,revision:{type:nonNull(GraphQLInt)},summary:{type:GraphQLString}}});
const productProject = new GraphQLObjectType({name:"ProductProject",fields:{id:{type:nonNull(GraphQLID)},title:text,revision:{type:nonNull(GraphQLInt)},summary:{type:GraphQLString},goals:{type:nonNull(new GraphQLList(nonNull(productReference)))}}});
const productCard = new GraphQLObjectType({name:"ProductCard",fields:{rank:{type:GraphQLInt},id:{type:nonNull(GraphQLID)},title:text,revision:{type:nonNull(GraphQLInt)},summary:{type:GraphQLString},revisions:{type:nonNull(new GraphQLList(nonNull(productReference)))},projects:{type:nonNull(new GraphQLList(nonNull(productProject)))}}});
const productPageType = new GraphQLObjectType({name:"ProductPage",fields:{id:{type:nonNull(GraphQLID)},name:text,slug:text,organizationSlug:text,periodStart:text,periodEnd:text,report:{type:JSONScalar},sourceContext:{type:nonNull(JSONScalar)},products:{type:nonNull(new GraphQLList(nonNull(productCard)))},markdown:text}});
async function productsPage(context: Context, at?: string | null) {
  try {
    const page = await readProductPage(context.host(),context.identity,at);
    const order = await readOrder(context.db(), context.identity, "products");
    const products = sortByOrder(page.products, order.items, item => item.id).map(item => ({...item, rank: order.items.includes(item.id) ? order.items.indexOf(item.id) : null}));
    return {...page,products,markdown:productPageMarkdown({...page,products})};
  }catch(error){if(error instanceof Response)throw new GraphQLError(await error.text());throw error;}
}
const dailyReportSource=new GraphQLObjectType({name:"DailyReportSource",fields:{id:{type:nonNull(GraphQLID)},name:text,ownerKind:text,ownerId:text,planningInstallationId:text,organizationSlug:{type:GraphQLString},report:{type:JSONScalar}}});
const partnerRequestStatus = new GraphQLEnumType({ name: "PartnerRequestStatus", values: { proposed: { value: "proposed" }, accepted: { value: "accepted" }, rejected: { value: "rejected" } } });
const partnerRequest = new GraphQLObjectType({ name: "PartnerRequest", description: "A design partner's feature or bug request, filed from its own organization.", fields: {
  id: { type: nonNull(GraphQLID) }, requestId: { type: nonNull(GraphQLID), description: "The partner's own ID for it." }, revision: { type: nonNull(GraphQLInt) },
  status: { type: nonNull(partnerRequestStatus), description: "proposed until an editor accepts (Software Foundry files it as an issue) or rejects it." },
  kind: { ...text, description: "feature or bug." }, title: text, problem: text,
  acceptanceCriteria: { type: nonNull(JSONScalar), description: "[{ id, text }]" },
  bug: { type: JSONScalar, description: "Bugs only: { stepsToReproduce, expected, actual, environment? }." },
  productId: { type: GraphQLID, description: "The provider's product record, by the ID both graphs share." },
  partner: { type: nonNull(JSONScalar), description: "{ organizationId, userId, role: \"design partner\" }" },
  reason: { type: GraphQLString, description: "Why it was rejected." },
  foundryRequest: { type: JSONScalar, description: "Once accepted: Foundry's request { requestId, kind, issue { number, url }, run }." },
  createdAt: { type: nonNull(GraphQLFloat), description: "Epoch milliseconds." }, updatedAt: { type: nonNull(GraphQLFloat) },
} });
const designPartner = new GraphQLObjectType({ name: "DesignPartner", fields: { organizationId: { type: nonNull(GraphQLID) }, name: text } });
const designPartnerList = new GraphQLObjectType({ name: "DesignPartners", fields: { designPartners: { type: nonNull(new GraphQLList(nonNull(designPartner))) } } });

const query = new GraphQLObjectType<unknown, Context>({
  name: "Query",
  fields: {
    partnerRequests: {
      type: nonNull(new GraphQLList(nonNull(partnerRequest))),
      description: "Design partners' feature and bug requests, newest first (at most 200), optionally by status. Editors only.",
      args: { status: { type: partnerRequestStatus } },
      resolve: async (_source, args: { status?: "proposed" | "accepted" | "rejected" | null }, context) => {
        try { return await listPartnerRequests(context, args.status ?? undefined); }
        catch (error) { throw await fieldError(error); }
      },
    },
    dailyReports:{type:nonNull(connectionType(dailyReportSource)),args:{...pageArgs(),date:{type:nonNull(GraphQLString)},timezone:{type:GraphQLString}},resolve:async(_source,args:PageArgs&{date:string;timezone?:string},context,info)=>{
      const {first,start}=pageStart(args),id=context.identity.installationId;
      if(start && id<=start)return page(context,info,[] as {id:string}[],row=>row.id,first,start);
      const report=await readDailyReport(context.host(),context.identity,{date:args.date,timezone:args.timezone});
      const row={id,name:"Daily report",ownerKind:context.identity.owner.kind,ownerId:context.identity.owner.id,planningInstallationId:id,organizationSlug:null,report};
      return page(context,info,[row],row=>row.id,first,start);
    }},
    priorityOrder: {type:nonNull(JSONScalar),args:{kind:{type:nonNull(GraphQLString)}},resolve:(_source,args:{kind:string},context)=>readOrder(context.db(),context.identity,z.enum(["projects","products"]).parse(args.kind))},
    personalPortfolio: {type:nonNull(JSONScalar),args:{kind:{type:nonNull(GraphQLString)}},resolve:(_source,args:{kind:string},context)=>personalPortfolio(context,z.enum(["organizations","projects"]).parse(args.kind))},
    productReportRuns: {type:nonNull(JSONScalar),resolve:(_source,_args,context)=>productReportRuns(context.host())},
    productReportSchedule: {type:nonNull(JSONScalar),resolve:(_source,_args,context)=>productReportSchedule(context.host())},
    products: {type:nonNull(new GraphQLList(nonNull(productCard))),args:{at:{type:GraphQLString}},resolve:async(_source,args:{at?:string},context)=>(await productsPage(context,args.at)).products},
    weeklyProductRoadmap: {type:nonNull(productPageType),args:{at:{type:GraphQLString}},resolve:(_source,args:{at?:string},context)=>productsPage(context,args.at)},
    productPage: {type:nonNull(productPageType),args:{at:{type:GraphQLString}},resolve:(_source,args:{at?:string},context)=>productsPage(context,args.at)},
    productPages: {type:nonNull(connectionType(productPageType)),args:{...pageArgs(),at:{type:GraphQLString}},resolve:async(_source,args:PageArgs&{at?:string},context,info)=>{
      const {first,start}=pageStart(args);
      const row=await productsPage(context,args.at);
      return page(context,info,start && row.id <= start ? [] : [row],row=>row.id,first,start);
    }},

    organizationGoals: {
      type: nonNull(connectionType(organizationGoals)),
      description: "This organization's goals and their metrics from the Wiki: one record for an organization whose Wiki has an Organization page bound to it, none on a personal installation.",
      args: { ...pageArgs() },
      resolve: async (_source, args: PageArgs & { ids?: string[] | null }, context, info) => {
        const { first, start } = pageStart(args);
        const ids = idList(args.ids);
        const record = await readOrganizationGoals(context.host(), context.identity);
        const rows = record && (!ids || ids.includes(record.id)) ? [record] : [];
        return { ...page(context, info, rows, (row) => row.id, first, start), aggregate: { count: rows.length } };
      },
    },
    projects: {
      type: nonNull(connectionType(Project)),
      description: "Projects with their open issue counts, in ID order. active: true keeps projects with at least one todo or in-progress issue, false the others.",
      args: { ...pageArgs(), active: { type: GraphQLBoolean }, archived:{type:GraphQLBoolean}, states:{type:new GraphQLList(nonNull(GraphQLString))} },
      resolve: async (_source, args: PageArgs & { ids?: string[] | null; active?: boolean | null; archived?:boolean | null; states?:string[] | null }, context, info) => {
        const { first, start } = pageStart(args);
        const ids = idList(args.ids);
        if (args.states?.some(state => !["draft", "backlog", "active", "completed", "archived"].includes(state))) throw new GraphQLError("Unknown project state");
        const matching = (after: string | null) => projectRows(context, { ids, active: args.active, archived: args.archived ?? (args.states?.includes("archived") ? null : false), states: args.states, after });
        const rows = await matching(start).orderBy(asc(projects.id)).limit(first + 1);
        return {
          ...page(context, info, rows, row => row.id, first, start),
          // Counted only when selected.
          aggregate: { count: async () => (await context.db().select({ count: count() }).from(matching(null).as("matching")))[0].count },
        };
      },
    },
    ...issueFields,
    metricMeasurements: mutationField<typeof metricMeasurementsInput, Context>({
      name: "MetricMeasurements",
      description: "Every MetricDefinition in the Wiki with its latest and previous recorded Measurement ({ value, unit, windowStart, windowEnd, capturedAt }) and the change between them, for KPIs such as this week's GitHub stars and growth since last week. latest is null until a Measure records one.",
      input: metricMeasurementsInput,
      run: (context, input) => readMetricMeasurements(context.host(), input),
    }),
    useCases: mutationField({
      name: "UseCases", description: "Read a canonical project's existing use cases with full scenario documents, IDs and revisions before editing.",
      input: z.strictObject({ projectId: z.uuid() }),
      run: (context: Context, input) => listUseCases(context.db(), context.identity, context.host(), input.projectId),
    }),
    intakeReleaseOptions: mutationField({
      name: "IntakeReleaseOptions", description: "Read the canonical project's existing Wiki Releases with their IDs, revisions and linked evidence before recording intake release fit.",
      input: z.strictObject({ projectId: z.uuid() }),
      run: (context: Context, input) => new IntakeService(context).releaseReview(input.projectId),
    }),
    intakes: {
      type: nonNull(connectionType(intake)),
      description: "Customer and competitive intakes with their routed child work, in ID order. Reading routes inspects each intake against Governance, so first defaults to 20.",
      args: { ...pageArgs(), first: { type: GraphQLInt, defaultValue: 20 } },
      resolve: async (_source, args: PageArgs & { ids?: string[] | null }, context, info) => {
        const { first, start } = pageStart(args);
        const ids = idList(args.ids);
        const service = new IntakeService(context);
        const rows = await service.page(first + 1, start, ids);
        return { ...page(context, info, rows, row => row.id, first, start), aggregate: { count: () => service.count(ids) } };
      },
    },
    intakeOptions: {
      type: nonNull(JSONScalar),
      description: "The active Governance work gates an intake route can use, with the work kinds each governs: { gates, error }. A route whose kind has exactly one is gated by it automatically; when the gates cannot be read, gates is empty and error says why.",
      resolve: async (_source, _args, context) => {
        try { return { gates: (await new IntakeService(context).options()).gates, error: null }; }
        catch (error) { return { gates: [], error: error instanceof Response ? await error.text() : "Governance gates unavailable" }; }
      },
    },
    projectDelivery: mutationField<typeof deliveryInput, Context>({
      name: "ProjectDelivery",
      description: "Read a project's delivery handoff as persisted: requirements with revisions, the latest preparation (routes, questions, conflicts, deferred claims, blockers with remediation), every Workshop and Foundry package with its frozen body and digest, Workshop and Foundry read-backs, milestone readiness from evidence and acceptance criteria still unverified. Changes nothing.",
      input: deliveryInput,
      run: (context, input) => projectDelivery(context, input),
    }),
    dailyReport: mutationField<typeof dailyReportReadInput, Context>({name:"DailyReport",description:"Read the exact generated project or owner report for a local calendar date, including source coverage, dependencies and pinned Wiki revision. Missing returns null, not no-change.",input:dailyReportReadInput,output:JSONScalar,run:(context,input)=>readDailyReport(context.host(),context.identity,input)}),
    projectDigests: mutationField<typeof digestListInput, Context>({
      name: "ProjectDigests",
      description: "A project's daily digests, newest first: what shipped, started, was added or reopened since the previous digest, and what is prioritized now. Changes nothing.",
      input: digestListInput, output: nonNull(new GraphQLList(nonNull(digest))),
      run: (context, input) => listDigests(context.db(), context.identity, input),
    }),
    digestRuns: {
      type: nonNull(JSONScalar),
      description: "The installation's latest project-digest runs as the platform records them, newest first: [{ id, status (running, complete or failed), createdAt, updatedAt }].",
      resolve: (_source, _args, context) => digestRuns(context.host()),
    },
    digestSchedule: {
      type: nonNull(digestScheduleType),
      description: "Whether the morning digest runs, and when it runs next.",
      resolve: (_source, _args, context) => digestSchedule(context.host()),
    },
    // A read that takes typed input, so it is built like a mutation field; graph.graphql serves it read only.
    intakeWorkPreview: mutationField<typeof previewIntakeInput, Context>({
      name: "IntakeWorkPreview",
      description: "Preview an implementation route's work package with the intake's current research, architecture and prioritization records as supporting sources: the preview to submit and the package with its digest. Changes nothing.",
      input: previewIntakeInput,
      run: (context, input) => previewIntakeWork(intakeService(context), input),
    }),
  },
});

/** A record named by ID at the revision the caller read; a changed record is refused (409). */
const recordChange = z.strictObject({ id: z.uuid(), revision: revisionField });
const projectChange = projectFields.extend(recordChange.shape);
const issueChange = issueInput.extend(recordChange.shape);
const deleted = new GraphQLObjectType({ name: "Deleted", fields: { deleted: { type: nonNull(GraphQLBoolean) } } });
const reordered = new GraphQLObjectType({ name: "Reordered", fields: { reordered: { type: nonNull(GraphQLBoolean) } } });
const claimedWork = new GraphQLObjectType({ name: "ClaimedWork", fields: {
  token: { type: nonNull(GraphQLID), description: "The requestId; recordResult carries it." },
  context: { type: nonNull(JSONScalar), description: "The work's deterministic context: markdown, digest and sources, as work.context serves it." },
} });

/** The organization members an assignment may name: the directory when assigning; an update
 * with no directory keeps only the stored assignee, which updateIssue checks atomically. */
function assignable(context: PlanningContext, assigneeId: string | null, update: boolean) {
  if (!assigneeId) return [];
  try { return context.members(); }
  catch (error) {
    if (update && error instanceof Response && error.status === 503) return [];
    throw error;
  }
}
const intakeService = (context: Context) => new IntakeService(context);
const revisionRule = "Name the revision you read; a changed record is refused (409).";

// Planning's writes, each the same domain function its page route or action runs.
// graph.mutate admits every member here (src/pages/api/internal/actions/v1/[operation].ts):
// members share projects and issues, intake writes need an editor, and claimWork,
// recordResult and publishResult check the caller holds the Governance duty.
const mutation = new GraphQLObjectType<unknown, Context>({
  name: "Mutation",
  fields: {
    generateProductReport: mutationField<typeof productReportInput,Context>({name:"GenerateProductReport",description:"Regenerate the selected calendar week (at), or current week, as a registered task. Editors only.",input:productReportInput,run:(context,input)=>startProductReport(context.host(),context.identity,input)}),
    changeProductReportSchedule: mutationField<typeof productReportScheduleInput,Context>({name:"ChangeProductReportSchedule",description:"Enable or disable daily roadmap regeneration. Editors only.",input:productReportScheduleInput,run:(context,input)=>changeProductReportSchedule(context.host(),context.identity,input)}),

    createIssue: mutationField<typeof issueInput, Context>({
      name: "CreateIssue",
      description: "Add an issue (a stone, pebble or sand) to a project, last in its category. An assignee must be a current organization member. Any member of the installation.",
      input: issueInput, output: nonNull(rowType(issueFields.issues)),
      run: (context, input) => createIssue(context.db(), context.identity, input, assignable(context, input.assigneeId, false)),
    }),
    updateIssue: mutationField<typeof issueChange, Context>({
      name: "UpdateIssue",
      description: `Replace an issue's fields. Moving it to another project or category appends it there. A departed member stays assigned only while assigneeId is unchanged. ${revisionRule}`,
      input: issueChange, output: nonNull(rowType(issueFields.issues)),
      run: (context, { id, ...input }) => updateIssue(context.db(), context.identity, id, input, assignable(context, input.assigneeId, true)),
    }),
    deleteIssue: mutationField<typeof recordChange, Context>({
      name: "DeleteIssue",
      description: `Delete an issue that has no sub-issues. ${revisionRule}`,
      input: recordChange, output: nonNull(deleted),
      run: (context, { id, revision }) => deleteIssue(context.db(), context.identity, id, { revision }),
    }),
    reorderIssues: mutationField<typeof reorderInput, Context>({
      name: "ReorderIssues",
      description: "Set the order of one category of a project's issues: every issue of that category, each at its current revision, in the new order. Any change meanwhile is refused (409).",
      input: reorderInput, output: nonNull(reordered),
      run: (context, input) => reorderIssues(context.db(), context.identity, input),
    }),
    createProject: mutationField<typeof createWithRequirements, Context>({
      name: "CreateProject",
      description: "Create a project with its name, GitHub repository link and documents (goals, user stories, press release, demo instructions and results, each Markdown of up to 16,000 characters), and optionally its requirements. Requirements start delivery preparation automatically; the answer says what changed and the preparation started. Any member of the installation.",
      input: createWithRequirements, output: nonNull(Project),
      run: async (context, { requirements, ...fields }) => {
        const saved = await saveProjectChange(context, { kind: "create", fields, requirements });
        const row = await savedProject(context, saved.projectId);
        return { ...row, ...deliveryResult(saved, row.revision) };
      },
    }),
    updateProject: mutationField<typeof projectChange, Context>({
      name: "UpdateProject",
      description: `Replace a project's name, repository and documents: a field left out is cleared, so send every document you read. ${revisionRule}`,
      input: projectChange, output: nonNull(Project),
      run: async (context, { id, ...input }) => savedProject(context, (await updateProject(context.db(), context.identity, id, input)).id),
    }),
    patchProject: mutationField<typeof patchProjectInput, Context>({
      name:"PatchProject",description:"Overlay only mask fields on an existing Projects record. Read with includeIdentifiers:true first. Revision conflicts require a fresh read; omitted fields are preserved.",
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve partial publication results across the two app databases
      input:patchProjectInput,output:nonNull(Project),run:async(context,{project,mask:{requirements,retireRequirements,repositories:desired,projectNode,...mask}})=>{
        if (desired !== undefined || projectNode !== undefined) {
          requireEditor(context.identity);
          if (desired !== undefined && mask.githubRepository !== undefined) throw new Response("Edit repositories or githubRepository in a patch, not both", { status: 400 });
          const current = await savedProject(context, project.id);
          if (!current || current.archived || current.revision !== project.revision) throw new Response("This record changed. Reload before retrying.", { status: 409 });
        }
        // Claim the Planning revision before making any cross-app writes.
        const saved = await saveProjectChange(context, { kind: "edit", project, mask, requirements: requirements ?? [], retire: retireRequirements ?? [] });
        let row = await savedProject(context, saved.projectId);
        let repositoryChanges: unknown = null;
        let projectNodeChanges: unknown = null;
        if (projectNode !== undefined) {
          try {
            projectNodeChanges = await linkProjectNode(context, project.id, row.name, projectNode);
          } catch (error) {
            projectNodeChanges = {
              state: "failed",
              error: error instanceof Response ? await error.text() : "Linking the Onto Project node failed. Reload and retry.",
              retry: { project: { id: row.id, revision: row.revision }, mask: { projectNode } },
            };
          }
        }
        if (desired !== undefined) {
          try {
            repositoryChanges = await publishRepositories(context, project.id, row.name, desired);
            const legacy = githubRepositoryName(row.githubRepository);
            if (legacy && !desired.some(repo => githubRepositoryName(repo.url) === legacy)) {
              // Preserve the legacy fallback until the Wiki publication has succeeded.
              await patchProjectRecord(context.db(), context.identity, { project: { id: row.id, revision: row.revision }, mask: { githubRepository: "" } });
              row = await savedProject(context, saved.projectId);
            }
          } catch (error) {
            row = await savedProject(context, saved.projectId);
            repositoryChanges = {
              state: "failed",
              error: error instanceof Response ? await error.text() : "Repository publication failed. Reload and retry the repository patch.",
              retry: { project: { id: row.id, revision: row.revision }, mask: { repositories: desired } },
            };
          }
        }
        return { ...row, ...deliveryResult(saved, row.revision), repositoryChanges, projectNodeChanges };
      },
    }),
    prepareProject: mutationField<typeof prepareInput, Context>({
      name:"PrepareProject",description:"Start delivery preparation again for a saved project revision whose dispatch failed or whose run failed. Uses the same preparation id, so it never duplicates work. Editors only.",
      input:prepareInput,output:nonNull(Project),run:async(context,input)=>{
        const saved = await prepareProject(context, input);
        const row = await savedProject(context, saved.projectId);
        return { ...row, ...deliveryResult(saved, input.project.revision) };
      },
    }),
    submitDeliveryPackage: mutationField<typeof submitPackageInput, Context>({
      name:"SubmitDeliveryPackage",description:"Submit a prepared Foundry package once, under requestId, at the digest you reviewed in ProjectDelivery. Requires an editor, a current unconflicted package, a ready implementation route and Governance approval of the package; without approval it asks for review and answers awaiting_review. Never merges, releases, publishes or manufactures.",
      input:submitPackageInput,run:(context,input)=>submitDeliveryPackage(context,input),
    }),
    reorderPriority: mutationField<typeof orderInput, Context>({
      name:"ReorderPriority", description:"Save the complete organization project or product order at the revision read.", input:orderInput, output:nonNull(JSONScalar),
      run:async(context,input)=>{
        const allowed = input.kind === "projects" ? (await context.db().select({id:projects.id}).from(projects).where(and(eq(projects.installationId,context.identity.installationId),eq(projects.archived,false)))).map(row=>row.id) : (await productsPage(context)).products.map(row=>row.id);
        return saveOrder(context.db(),context.identity,input,allowed);
      },
    }),
    reorderPersonalPortfolio: mutationField<typeof portfolioOrderInput, Context>({
      name: "ReorderPersonalPortfolio", description: "Save your personal organization or cross-organization project order at the revision read. Does not change shared priorities.",
      input: portfolioOrderInput, output: nonNull(JSONScalar), run: reorderPersonalPortfolio,
    }),
    setProjectState: mutationField<typeof projectStateInput, Context>({
      name: "SetProjectState", description: "Set the project lifecycle state at the revision read; archived projects can be restored.",
      input: projectStateInput, output: nonNull(Project), run: async (context, input) => savedProject(context, (await setProjectState(context.db(), context.identity, input)).id),
    }),
    archiveProject: mutationField<typeof archiveProjectInput, Context>({
      name:"ArchiveProject",description:"Archive a project at its current revision without deleting its issues or documents.",
      input:archiveProjectInput,output:nonNull(Project),run:async(context,input)=>savedProject(context,(await archiveProject(context.db(),context.identity,input)).id),
    }),
    deleteProject: mutationField<typeof recordChange, Context>({
      name: "DeleteProject",
      description: `Delete a project that has no issues. ${revisionRule}`,
      input: recordChange, output: nonNull(deleted),
      run: (context, { id, revision }) => deleteProject(context.db(), context.identity, id, { revision }),
    }),
    setIntakeReleaseFit: mutationField<typeof releaseFitInput, Context>({
      name: "SetIntakeReleaseFit", description: "Record current-release, deferred, needs-research or rejected with rationale, an optional existing project Release revision, and history. Current-release requires a Release; deferred without one stays in intake backlog. Optimistic revision and stable requestId required. Does not approve or start delivery. Editors only.",
      input: releaseFitInput, output: nonNull(intake),
      run: (context, input) => setIntakeReleaseFit(intakeService(context), input),
    }),
    createIntake: mutationField<typeof intakeInput, Context>({
      name: "CreateIntake",
      description: "Capture a customer or competitive intake under a stable requestId (replaying it returns the saved intake) and route it: the configured model proposes the child work, each route gated by the one active Governance control for its kind. When routing fails the intake is still saved, with routingError; routeIntake runs it later. Editors only.",
      input: intakeInput, output: nonNull(intake),
      run: (context, input) => createIntake(intakeService(context), input),
    }),
    routeIntake: mutationField<typeof routeInput, Context>({
      name: "RouteIntake",
      description: "Route an intake whose work has not started, or set its canonical Planning project (required before implementation, changeable until implementation starts): with projectId alone the routes stay as they are; without a proposal the configured model proposes the child work; with one, those routes replace the current ones (implementation always waits for the selected discovery work). Name the intake revision you read. Editors only.",
      input: routeInput, output: nonNull(intake),
      run: (context, input) => routeIntake(intakeService(context), input),
    }),
    claimWork: mutationField<typeof claimInput, Context>({
      name: "ClaimWork",
      description: "Claim a route's work for 15 minutes under a stable requestId and get its deterministic context. The caller must hold the perform (or recommend) duty of the route's control, the route's prerequisites must be approved, and nobody else may hold a live claim. Replaying the requestId renews the claim.",
      input: claimInput, output: nonNull(claimedWork),
      run: (context, input) => claimWork(intakeService(context), input),
    }),
    saveResultDraft: mutationField<typeof saveDraftInput, Context>({
      name: "SaveResultDraft",
      description: "Save a draft of a route's findings under a live claim (token) without requesting review. The draft may be incomplete; each save replaces the previous one, so an agent keeps adding sources and findings and then submits with recordResult. Returns { intakeId, revision, childId, savedAt }. The route's work record and its revision, which Governance reviews, do not change; the intake's revision does.",
      input: saveDraftInput,
      run: (context, input) => saveResultDraft(intakeService(context), input),
    }),
    recordResult: mutationField<typeof recordResultInput, Context>({
      name: "RecordResult",
      description: "Submit research, architecture or prioritization findings under a live claim (token) and request the route's Governance review: pass result, or omit it to submit the draft saved with saveResultDraft; the previous result is kept in history. Architecture needs an approach; prioritization a disposition; an incomplete draft is refused (422). Without token and result, or with the same result again under the same token, it only asks the gate again to review the recorded result: any holder of the route's perform or recommend duty may, such as the Recommend holder after a perform-only worker recorded it. Provenance is agent-reported.",
      input: recordResultInput, output: nonNull(intake),
      run: (context, input) => recordResult(intakeService(context), input),
    }),
    reviseIntakeScope: mutationField<typeof reviseScopeInput, Context>({
      name: "ReviseIntakeScope",
      description: `Approve a changed title, description or sources under a stable requestId. Previous scope and results stay in history and every route gets a new identity, so earlier decisions cannot authorize the change; submitted delivery is frozen. ${revisionRule} Editors only.`,
      input: reviseScopeInput, output: nonNull(intake),
      run: (context, input) => reviseScope(intakeService(context), input),
    }),
    publishResult: mutationField<typeof selection, Context>({
      name: "PublishResult",
      description: "Publish a route's recorded result to the Wiki as a proposed, agent-reported assertion on the intake's node, and return the Wiki record. Publishing again returns the existing record; a differing one is refused. Editors, or the route's assigned holder.",
      input: selection,
      run: (context, input) => publishResult(intakeService(context), input),
    }),
    submitIntakeWork: mutationField<typeof submitIntakeInput, Context>({
      name: "SubmitIntakeWork",
      description: "Submit a ready implementation route's work package to Foundry once, under work.requestId, with the preview and expectedDigest intakeWorkPreview returned and a selected Governance control; the delivery is recorded on the route. Editors only.",
      input: submitIntakeInput,
      run: (context, input) => submitIntakeWork(intakeService(context), input),
    }),
    resetIntakeSubmission: mutationField<typeof resetSubmissionInput, Context>({
      name: "ResetIntakeSubmission",
      description: `Reset an implementation submission Foundry rejected before creating a delivery record, so a corrected package can be submitted. ${revisionRule} Editors only.`,
      input: resetSubmissionInput, output: nonNull(intake),
      run: (context, input) => resetSubmission(intakeService(context), input),
    }),
    generateDailyReports: mutationField<typeof dailyReportsInput, Context>({name:"GenerateDailyReports",description:"Start one durable task that captures every active project's previous local day, then saves this owner's overview from those exact reports.",input:dailyReportsInput,output:nonNull(JSONScalar),run:(context,input)=>startDailyReports(context.host(),context.identity,input)}),
    generateProjectDigest: mutationField<typeof generateDigestInput, Context>({
      name: "GenerateProjectDigest",
      description: "Start the project-digest task for one project: the platform runs it durably and records its run; the digest appears in projectDigests when the run completes. Returns { id, task, created }: id is the run, read with digestRuns or the platform's TaskRuns. Editors only.",
      input: generateDigestInput,
      run: (context, input) => startDigest(context.db(), context.host(), context.identity, input),
    }),
    changeDigestSchedule: mutationField<typeof digestScheduleInput, Context>({
      name: "ChangeDigestSchedule",
      description: "Turn the morning digest of every active project on or off; it runs as the caller every day at 13:00 UTC. Editors only.",
      input: digestScheduleInput, output: nonNull(digestScheduleType),
      run: (context, input) => changeDigestSchedule(context.host(), context.identity, input),
    }),
    linkProjectChanges: mutationField<typeof linkChangesInput, Context>({
      name: "LinkProjectChanges",
      description: "Link the pull requests merged into each project's repositories (its Wiki node's source_in edges) over the last days (default 7) to the project in the Wiki: one change batch of CodeChange records with merged_into and delivers relationships, each with its evidence and reason. Confident links commit by policy; the rest wait for review on the Wiki's Changes page. Returns { runId, batchId, state, pullRequests, proposals, skipped, unread }. Editors only.",
      input: linkChangesInput,
      run: (context, input) => linkProjectChanges(context.db(), context.host(), context.identity, input),
    }),
    recordMeasurements: mutationField<typeof recordMeasurementsInput, Context>({
      name: "RecordMeasurements",
      description: "Record every Measure in the Wiki for its last completed window (the previous week from Monday 00:00 UTC, or yesterday): run its connector operation (for example PostHog query.run, Grafana query.run or GitHub repositories.read) through the organization's connection and stage one Measurement per Measure, linked measurement_of its MetricDefinition and captured_with the Measure, in one change batch that commits by policy. A window already recorded is skipped; a failed read records nothing and is listed in unread. Returns { runId, batchId, state, measures, recorded, skipped, unread }. Editors only.",
      input: recordMeasurementsInput,
      run: (context, input) => recordMeasurements(context.host(), context.identity, input),
    }),
    submitPartnerRequest: mutationField<typeof partnerRequestInput, Context>({
      name: "SubmitPartnerRequest",
      description: "File a feature or bug request with this organization as one of its design partners, from your own organization (graph_mutate with scope set to this organization and fromScope to yours). It waits as proposed until an editor here accepts or rejects it; replay the same requestId to read its status. Design partners only: other customers file an issue on the public repository.",
      input: partnerRequestInput, output: nonNull(partnerRequest), external: true,
      run: submitPartnerRequest,
    }),
    refreshDesignPartners: mutationField<typeof refreshPartnersInput, Context>({
      name: "RefreshDesignPartners",
      description: "Re-read this organization's design partners from its graph: customers whose customer_of link to it has design_partner set, each bound to a platform organization by organization_id. Only they can submit partner requests. Editors only.",
      input: refreshPartnersInput, output: nonNull(designPartnerList),
      run: context => refreshDesignPartners(context),
    }),
    acceptPartnerRequest: mutationField<typeof acceptPartnerRequestInput, Context>({
      name: "AcceptPartnerRequest",
      description: `Accept a design partner's proposed request: if the graph still flags the partner, Software Foundry's RequestChanges files it as an issue in the repository or project you name, attributed to you, with the partner named in the problem and its product in the context. ${revisionRule} A refusal keeps it proposed. Editors only.`,
      input: acceptPartnerRequestInput, output: nonNull(partnerRequest),
      run: acceptPartnerRequest,
    }),
    rejectPartnerRequest: mutationField<typeof rejectPartnerRequestInput, Context>({
      name: "RejectPartnerRequest",
      description: `Reject a design partner's proposed request with a reason the partner reads back. Nothing is filed. ${revisionRule} Editors only.`,
      input: rejectPartnerRequestInput, output: nonNull(partnerRequest),
      run: rejectPartnerRequest,
    }),
    saveUseCase: mutationField<typeof useCaseInput, Context>({
      name: "SaveUseCase",
      description: "Create a use case in the Wiki for a project, or with id and revision replace one's title, summary, document and archived flag, and return the Wiki record. Editors only.",
      input: useCaseInput,
      run: (context, input) => saveUseCase(context.db(), context.identity, context.host(), input),
    }),
  },
});

/** What this app serves over graph.graphql and graph.mutate (printed to graph/schema.graphql
 * by scripts/graph-schema.ts): projects with their open issue counts, issues,
 * intakes with their routed work, and the writes its documents (src/server/documents.ts) run. */
const baseGraphqlSchema = new GraphQLSchema({ query, mutation });

export const graphqlSchema = batchSchema(readBatchSchema(baseGraphqlSchema, readGroups), batchGroups);
