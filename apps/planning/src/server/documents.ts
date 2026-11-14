// Internal page documents and the explicitly selected MCP subset below reuse
// the same app-owned schema, services and authorization. Generated helpers alone
// do not publish agent capabilities.
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { documentRunner } from "@ai-outfitter/app-sdk/app-graphql";
import { readBatchDocuments, withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import type { TadaDocumentNode } from "@ai-outfitter/app-sdk/graph-graphql-typed";
import { graphql } from "../../graph/graphql";
import { batchGroups, readGroups } from "./batch-groups";
import { graphqlSchema } from "./graphql";
import type { PlanningContext } from "./intake";

// Selections are spelled out: gql.tada types a document only from a literal string.
const legacyDocuments = defineDocuments({
  PortfolioProjects: {
    story: "As a personal portfolio owner, I want a small authorized project index without loading every project's graph, so that ordering stays responsive.",
    document: graphql(`query PortfolioProjects($first:Int=100,$after:String){projects(first:$first,after:$after,archived:false){nodes{id name state archived revision rank} pageInfo{endCursor hasNextPage}}}`),
  },
  DailyReports:{story:"As a personal overview workflow, I want one daily report outcome per authorized Planning scope including missing reports, so that dependent reports can wait on exact persisted organization outcomes.",document:graphql(`query DailyReports($date:String!,$timezone:String,$first:Int=20,$after:String){dailyReports(date:$date,timezone:$timezone,first:$first,after:$after){nodes{id name ownerKind ownerId planningInstallationId organizationSlug report}pageInfo{hasNextPage endCursor}}}`)},
  DailyReport:{story:"As a member or a personal overview workflow, I want this scope's daily report with exact source revisions and coverage, so that an overview depends on persisted source outcomes.",document:graphql(`query DailyReport($input:DailyReportInput!){dailyReport(input:$input)}`)},
  GenerateDailyReports:{story:"As an editor, I want all active project reports for a selected recovery date or previous local day followed by this owner's overview in one durable run, so that failures remain visible and retries preserve captured reports.",document:graphql(`mutation GenerateDailyReports($input:GenerateDailyReportsInput!){generateDailyReports(input:$input)}`)},
  GenerateProductReport: {story:"As an editor, I want to regenerate the selected or current week's product roadmap in a registered workflow, so that updated graph evidence informs a draft for review.",document:graphql(`mutation GenerateProductReport($input:GenerateProductReportInput!) {generateProductReport(input:$input)}`)},
  ProductReportRuns: {story:"As a member, I want to see roadmap workflow progress and failures, so that missing reports are visible and retryable.",document:graphql(`query ProductReportRuns {productReportRuns}`)},
  ProductReportSchedule: {story:"As an editor, I want to inspect the daily product roadmap schedule, so that failed or missing updates are visible.",document:graphql(`query ProductReportSchedule {productReportSchedule}`)},
  ChangeProductReportSchedule: {story:"As an editor, I want to enable daily regeneration of the weekly roadmap, so that the working report stays current.",document:graphql(`mutation ChangeProductReportSchedule($input:ChangeProductReportScheduleInput!) {changeProductReportSchedule(input:$input)}`)},
  Products: {
    story: "As a member, I want products with the current weekly roadmap and linked projects and goals, so that I can plan from one organization-scoped view.",
    document: graphql(`query Products($first: Int = 20, $after: String, $at: String) {
      productPages(first:$first,after:$after,at:$at) { nodes { id name slug organizationSlug periodStart periodEnd report sourceContext products { id title summary revision rank revisions { id title revision } projects { id title revision goals { id title revision } } } } pageInfo {endCursor hasNextPage} }
    }`),
  },
  ProductSummaries: {
    story: "As a member or agent, I want the Products page as Markdown including its weekly roadmap and linked context, so that people and agents read the same report.",
    document: graphql(`query ProductSummaries($first: Int = 20, $after: String, $at: String) {
      productSummaries: productPages(first:$first,after:$after,at:$at) { nodes { name slug organizationSlug periodStart periodEnd markdown } pageInfo {endCursor hasNextPage} }
    }`),
  },
  Projects: {
    story: "As a member, I want to discover projects with their goals, repositories and open issue counts, optionally filtering active projects or IDs and paging through results, so that I can choose the project to inspect or work on.",
    document: graphql(`query Projects($first: Int = 20, $after: String, $ids: [ID!], $active: Boolean, $archived: Boolean, $states: [String!]) {
      projects(first: $first, after: $after, ids: $ids, active: $active, archived:$archived, states:$states) {
        nodes { id name slug githubRepository goals openIssues revision archived state rank
          useCases { id title summary revision }
          customerSegments { id title summary revision }
          userStories: userStoryRecords { id title summary revision }
          goalRecords { id title summary revision }
          readiness { stage priority missing signals }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`),
  },
  Issues: {
    story: "As a member or agent, I want to page through a project's issues with their IDs, revisions and order, so that I can reconcile issue changes and avoid duplicate work.",
    document: graphql(`query Issues($first: Int = 20, $after: String, $ids: [ID!], $projectId: [ID!], $status: [String!], $category: [String!]) {
      issues(first: $first, after: $after, ids: $ids, projectId: $projectId, status: $status, category: $category) {
        nodes { id projectId parentId title description category status assigneeId dueDate position revision createdAt updatedAt }
        pageInfo { endCursor hasNextPage }
      }
    }`),
  },
  ProjectRepositories: {
    story: "As a member, I want to inspect the repositories and recent pull requests linked to a project, so that I can understand its code activity.",
    document: graphql(`query ProjectRepositories($ids:[ID!],$first:Int=20,$after:String) {
      projects(ids:$ids,first:$first,after:$after) { nodes { id name repositories(first:100) { nodes { id nameWithOwner url path ref pullRequestActivity(first:20) { error pullRequests { nodes { number title url state createdAt updatedAt closedAt mergedAt } pageInfo { endCursor hasNextPage } } } } pageInfo { endCursor hasNextPage } } } pageInfo { endCursor hasNextPage } }
    }`),
  },
  OrganizationGoals: {
    story: "As a member or agent, I want each organization's goals and the metrics that measure them, so that projects are read against what the organization is pursuing.",
    document: graphql(`query OrganizationGoals($first: Int = 20, $after: String, $ids: [ID!]) {
      organizationGoals(first: $first, after: $after, ids: $ids) {
        nodes { id revision title summary truncated
          goals { id title summary revision metrics { id title summary } }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`),
  },
  ProjectSummaries: {
    story: "As a member, I want to discover projects with their repositories and open issue counts, optionally filtering active projects or IDs and paging through results, so that I can choose the project to inspect or work on.",
    document: graphql(`query ProjectSummaries($first: Int = 20, $after: String, $ids: [ID!], $active: Boolean, $archived: Boolean, $states: [String!]) {
      projectSummaries: projects(first: $first, after: $after, ids: $ids, active: $active, archived:$archived, states:$states) {
        nodes { name slug githubRepository openIssues state
          useCases { title summary }
          customerSegments { title summary }
          userStories: userStoryRecords { title summary }
        }
        pageInfo { endCursor hasNextPage }
      }
    }`),
  },
  Intakes: {
    story: "As an agent, I want the intakes with their routed work, each route's blocker and draft, and the active Governance work gates, so that I can find work that is ready, see which routes are gated, and follow review and delivery.",
    document: graphql(`query Intakes($first: Int = 20, $after: String) {
      intakeOptions
      intakes(first: $first, after: $after) { nodes {
        id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
        routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
      } pageInfo { endCursor hasNextPage } }
    }`),
  },
  CreateIssue: {
    story: "As a member, I want to add a stone, pebble or sand issue to a project from the project page or an agent, so that the team's work is broken down where everyone sees it.",
    document: graphql(`mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { id projectId parentId title description category status assigneeId dueDate position revision createdAt updatedAt } }`),
  },
  UpdateIssue: {
    story: "As a member, I want to edit, assign, complete or move an issue at the revision I read, so that nobody's change is silently overwritten.",
    document: graphql(`mutation UpdateIssue($input: UpdateIssueInput!) { updateIssue(input: $input) { id projectId parentId title description category status assigneeId dueDate position revision createdAt updatedAt } }`),
  },
  DeleteIssue: {
    story: "As a member, I want to delete an issue that is no longer needed, so that the project shows only live work.",
    document: graphql(`mutation DeleteIssue($input: DeleteIssueInput!) { deleteIssue(input: $input) { deleted } }`),
  },
  ReorderIssues: {
    story: "As a member, I want to move an issue up or down within its category, so that the order reflects the team's priority.",
    document: graphql(`mutation ReorderIssues($input: ReorderIssuesInput!) { reorderIssues(input: $input) { reordered } }`),
  },
  CreateProject: {
    story: "As a member, I want to create a project with its goals, user stories, press release and demo documents from the projects page or an agent, so that the team plans from one shared outcome.",
    document: graphql(`mutation CreateProject($input: CreateProjectInput!) { createProject(input: $input) { id name githubRepository goals userStories pressRelease demoInstructions demoResults archived revision openIssues updatedAt requirementChanges preparation run instructions } }`),
  },
  UpdateProject: {
    story: "As a member, I want to revise a project's name, repository and documents at the revision I read, so that nobody's change is silently overwritten.",
    document: graphql(`mutation UpdateProject($input: UpdateProjectInput!) { updateProject(input: $input) { id name githubRepository goals userStories pressRelease demoInstructions demoResults archived revision openIssues updatedAt } }`),
  },
  PatchProject: {
    story:"As a member, I want to apply only my project's edited fields, so that omitted documents remain unchanged.",
    document:graphql(`mutation PatchProject($input:PatchProjectInput!){patchProject(input:$input){id name githubRepository goals userStories pressRelease demoInstructions demoResults archived revision requirementChanges repositoryChanges projectNodeChanges preparation run instructions}}`),
  },
  PrepareProject: {
    story:"As an editor or agent, I want to retry a project's delivery preparation after its dispatch failed, so that a saved requirement change is never lost or prepared twice.",
    document:graphql(`mutation PrepareProject($input:PrepareProjectInput!){prepareProject(input:$input){id name archived revision requirementChanges preparation run instructions}}`),
  },
  ProjectDelivery: {
    story:"As a member or agent, I want to read a project's requirements, preparation, Workshop and Foundry packages, their read-backs and milestone readiness in one place, so that I verify the handoff from persisted state rather than an agent's summary.",
    document:graphql(`query ProjectDelivery($input:ProjectDeliveryInput!){projectDelivery(input:$input)}`),
  },
  SubmitDeliveryPackage: {
    story:"As an editor, I want to submit the Foundry package I reviewed under its Governance control, so that delivery starts from exactly that frozen package and nothing else is authorized by it.",
    document:graphql(`mutation SubmitDeliveryPackage($input:SubmitDeliveryPackageInput!){submitDeliveryPackage(input:$input)}`),
  },
  PriorityOrder: {story:"As a member, I want to read the organization order, so that I can reorder the current list safely.",document:graphql(`query PriorityOrder($kind:String!){priorityOrder(kind:$kind)}`)},
  PersonalPortfolio: {story:"As a personal user, I want my authorized organizations and projects in my own order, so that I can focus without changing shared priorities.",document:graphql(`query PersonalPortfolio($kind:String!){personalPortfolio(kind:$kind)}`)},
  ReorderPersonalPortfolio: {story:"As a personal user, I want to reorder my organizations or cross-organization projects, so that my daily overview follows my priorities.",document:graphql(`mutation ReorderPersonalPortfolio($input:ReorderPersonalPortfolioInput!){reorderPersonalPortfolio(input:$input)}`)},
  ReorderPriority: {story:"As a member, I want to reorder projects or products, so that the organization can communicate its priorities.",document:graphql(`mutation ReorderPriority($input:ReorderPriorityInput!){reorderPriority(input:$input)}`)},
  SetProjectState: {
    story: "As a member, I want to change a project lifecycle state, so that the projects list reflects the work status.",
    document: graphql(`mutation SetProjectState($input:SetProjectStateInput!){setProjectState(input:$input){id name state archived revision}}`),
  },
  ArchiveProject: {
    story:"As a member, I want to archive a project without deleting its issues or documents, so that its history stays available.",
    document:graphql(`mutation ArchiveProject($input:ArchiveProjectInput!){archiveProject(input:$input){id name githubRepository goals userStories pressRelease demoInstructions demoResults archived revision}}`),
  },
  DeleteProject: {
    story: "As a member, I want to delete an empty project, so that abandoned projects leave the list.",
    document: graphql(`mutation DeleteProject($input: DeleteProjectInput!) { deleteProject(input: $input) { deleted } }`),
  },
  IntakeReleaseOptions: {
    story: "As an editor, I want the intake project's existing Releases and their revisions, so that I choose a real Release when recording release fit.",
    document: graphql(`query IntakeReleaseOptions($input: IntakeReleaseOptionsInput!) { intakeReleaseOptions(input: $input) }`),
  },
  SetIntakeReleaseFit: {
    story: "As an editor, I want to record how a conversational intake fits an existing project Release, or defer it in backlog, so that discovery and delivery use the persisted decision and its rationale.",
    document: graphql(`mutation SetIntakeReleaseFit($input: SetIntakeReleaseFitInput!) { setIntakeReleaseFit(input: $input) { id revision releaseFit releaseFitHistory } }`),
  },
  CreateIntake: {
    story: "As an editor, I want to capture a customer or competitive intake from the intake page or an agent and have it routed, so that the right discovery and delivery work starts under Governance.",
    document: graphql(`mutation CreateIntake($input: CreateIntakeInput!) {
      createIntake(input: $input) {
      id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
      routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
    }
    }`),
  },
  RouteIntake: {
    story: "As an editor, I want to route an intake again, set its routes and decision controls myself, or assign its canonical Planning project, so that unstarted work follows the plan I chose and is delivered against the right project.",
    document: graphql(`mutation RouteIntake($input: RouteIntakeInput!) {
      routeIntake(input: $input) {
      id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
      routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
    }
    }`),
  },
  ReviseIntakeScope: {
    story: "As an editor, I want to approve a changed scope for an intake, so that new routes replace the old ones while previous results stay in history and old decisions cannot authorize the change.",
    document: graphql(`mutation ReviseIntakeScope($input: ReviseIntakeScopeInput!) {
      reviseIntakeScope(input: $input) {
      id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
      routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
    }
    }`),
  },
  ClaimWork: {
    story: "As an assigned agent, I want to claim a route's work and receive its deterministic context, so that I work on current sources and approved prerequisites without colliding with another holder.",
    document: graphql(`mutation ClaimWork($input: ClaimWorkInput!) { claimWork(input: $input) { token context } }`),
  },
  SaveResultDraft: {
    story: "As an assigned agent, I want to keep saving my findings to a draft under my claim as I research, so that the evidence builds up without asking for review until I submit it with RecordResult.",
    document: graphql(`mutation SaveResultDraft($input: SaveResultDraftInput!) { saveResultDraft(input: $input) }`),
  },
  RecordResult: {
    story: "As an assigned agent or Recommend holder, I want to submit findings or my saved draft under my claim and have Governance asked to review them, or ask again when that request failed or a perform-only worker recorded them, so that dependent work can proceed once they are approved.",
    document: graphql(`mutation RecordResult($input: RecordResultInput!) {
      recordResult(input: $input) {
      id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
      routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
    }
    }`),
  },
  PublishResult: {
    story: "As an assigned agent, I want to publish my recorded finding to the Wiki as a proposed assertion, so that reviewers and later work see the evidence in the knowledge graph.",
    document: graphql(`mutation PublishResult($input: PublishResultInput!) { publishResult(input: $input) }`),
  },
  IntakeWorkPreview: {
    story: "As an editor or assigned agent, I want to preview an intake's implementation work package with its approved discovery records, so that I submit exactly the package I reviewed.",
    document: graphql(`query IntakeWorkPreview($input: IntakeWorkPreviewInput!) { intakeWorkPreview(input: $input) }`),
  },
  SubmitIntakeWork: {
    story: "As an editor, I want to submit an intake's ready implementation work to Foundry under its Governance control, so that delivery starts from the reviewed package and is recorded on the intake.",
    document: graphql(`mutation SubmitIntakeWork($input: SubmitIntakeWorkInput!) { submitIntakeWork(input: $input) }`),
  },
  ResetIntakeSubmission: {
    story: "As an editor, I want to reset a submission Foundry rejected before any delivery was created, so that I can correct the package and submit again.",
    document: graphql(`mutation ResetIntakeSubmission($input: ResetIntakeSubmissionInput!) {
      resetIntakeSubmission(input: $input) {
      id revision projectId kind title description sourceUrls sources originatingMessage releaseFit releaseFitHistory routing routingError
      routes { id revision kind dependsOn rationale gate { installationId controlId } blocker claim { principal until } draft result observedAt gateReceipt gateError receipt submissionIntent subject }
    }
    }`),
  },
  ProjectDigests: {
    story: "As a member, I want to read a project's daily digests from its Daily digest page or an agent, so that I see what shipped and what is now prioritized without reading every issue.",
    document: graphql(`query ProjectDigests($input: ProjectDigestsInput!) { projectDigests(input: $input) { id projectId trigger since createdAt summary summaryError changes } }`),
  },
  GenerateProjectDigest: {
    story: "As an editor, I want to start a project's digest now from its Daily digest page or an agent, so that I can catch up on what changed since the last one without waiting for the morning; the platform runs it and keeps its run.",
    document: graphql(`mutation GenerateProjectDigest($input: GenerateProjectDigestInput!) { generateProjectDigest(input: $input) }`),
  },
  DigestRuns: {
    story: "As a member, I want to see whether a digest is still running or failed, so that I know whether to wait or open its run.",
    document: graphql(`query DigestRuns { digestRuns }`),
  },
  DigestSchedule: {
    story: "As an editor, I want to see whether the morning digest is on and when it runs next, so that I know the team will get one.",
    document: graphql(`query DigestSchedule { digestSchedule { cron timezone enabled nextRunAt lastRunAt lastOutcome } }`),
  },
  ChangeDigestSchedule: {
    story: "As an editor, I want to turn the morning digest of every project on or off, so that the team gets a daily summary of what shipped and what is prioritized without anyone clicking.",
    document: graphql(`mutation ChangeDigestSchedule($input: ChangeDigestScheduleInput!) { changeDigestSchedule(input: $input) { cron timezone enabled nextRunAt lastRunAt lastOutcome } }`),
  },
  LinkProjectChanges: {
    story: "As an editor, I want to link the pull requests merged into my projects' repositories to those projects in the Wiki from the project page or an agent, so that the knowledge graph shows which code changes delivered each project's work, with a reason a member can review.",
    document: graphql(`mutation LinkProjectChanges($input: LinkProjectChangesInput!) { linkProjectChanges(input: $input) }`),
  },
  RecordMeasurements: {
    story: "As an editor, I want to record this week's KPI values from our connectors (PostHog, GitHub) from Planning or an agent, so that each metric has an observed value per week instead of a definition alone.",
    document: graphql(`mutation RecordMeasurements($input: RecordMeasurementsInput!) { recordMeasurements(input: $input) }`),
  },
  MetricMeasurements: {
    story: "As a member, I want each metric's latest and previous recorded values and the change between them, so that I and agents can see this week's KPI and its growth since last week.",
    document: graphql(`query MetricMeasurements($input: MetricMeasurementsInput!) { metricMeasurements(input: $input) }`),
  },
  UseCases: {
    story: "As a member, I want a project's complete existing use-case scenarios and revisions, so that I can author and safely revise their actor, trigger, steps, alternatives and success evidence.",
    document: graphql(`query UseCases($input: UseCasesInput!) { useCases(input: $input) }`),
  },
  SubmitPartnerRequest: {
    story: "As a design partner's agent, I want to file a feature or bug request for my provider's product from my own organization, so that the provider's team reviews it and files it with Software Foundry, and I can read back whether it was accepted.",
    document: graphql(`mutation SubmitPartnerRequest($input: SubmitPartnerRequestInput!) {
      submitPartnerRequest(input: $input) { id requestId revision status kind title problem acceptanceCriteria bug productId partner reason foundryRequest createdAt updatedAt }
    }`),
  },
  PartnerRequests: {
    story: "As an editor, I want the requests our design partners filed, with their status, so that I accept or reject each one.",
    document: graphql(`query PartnerRequests($status: PartnerRequestStatus) {
      partnerRequests(status: $status) { id requestId revision status kind title problem acceptanceCriteria bug productId partner reason foundryRequest createdAt updatedAt }
    }`),
  },
  RefreshDesignPartners: {
    story: "As an editor, I want to refresh our design partners from our graph after flagging a customer, so that the new partner can submit requests and a removed one no longer can.",
    document: graphql(`mutation RefreshDesignPartners($input: JSON!) { refreshDesignPartners(input: $input) { designPartners { organizationId name } } }`),
  },
  AcceptPartnerRequest: {
    story: "As an editor, I want to accept a design partner's request for a repository or Foundry project, so that Software Foundry files it as an issue with the partner and its product named.",
    document: graphql(`mutation AcceptPartnerRequest($input: AcceptPartnerRequestInput!) {
      acceptPartnerRequest(input: $input) { id requestId revision status kind title productId partner foundryRequest updatedAt }
    }`),
  },
  RejectPartnerRequest: {
    story: "As an editor, I want to reject a design partner's request with a reason, so that the partner knows why and nothing is filed.",
    document: graphql(`mutation RejectPartnerRequest($input: RejectPartnerRequestInput!) {
      rejectPartnerRequest(input: $input) { id requestId revision status title partner reason updatedAt }
    }`),
  },
  SaveUseCase: {
    story: "As an editor, I want to write or revise a project's use case from the use cases page or an agent, so that it lives in the Wiki linked to the project.",
    document: graphql(`mutation SaveUseCase($input: SaveUseCaseInput!) { saveUseCase(input: $input) }`),
  },
});

export const documents = publishDocuments(readBatchDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), graphqlSchema, readGroups), {
  PortfolioProjects: {description: "Read a compact authorized project index for personal portfolio ordering; no linked graph or provider activity is loaded.", collection:true, provenance:"organizationSlug"},
  UseCases: {description: "Read complete project-linked use-case documents and revisions before authoring scenarios or editing. Names and summaries alone are insufficient for scenario review."},
  SaveUseCase: {description: "Save a complete use case against an existing project: actor, goal, trigger, steps, alternatives and observable successCriteria. Editors only. Read UseCases first; edits require both ID and revision."},
  IntakeReleaseOptions: {description: "Read existing project-linked Release records and revisions before deciding release fit. Does not create Releases."},
  Intakes: {description: "Read persisted conversational intakes, release fit and history, routed discovery, blockers and delivery receipts. Read IDs and revisions before writing."},
  CreateIntake: {description: "Persist an intake with a stable requestId and optional originatingMessage provenance, then propose governed child work. Retry the identical input with the same requestId."},
  SetIntakeReleaseFit: {description: "Record an explicit release disposition and rationale at the intake revision. Current-release requires an existing linked Release revision. Deferred without a release stays in backlog. Does not authorize delivery."},
  RouteIntake: {description: "Assign a project or route unstarted intake work with existing Governance controls; requires current intake revision."},
  ReviseIntakeScope: {description: "Approve revised intake scope, retaining history and resetting route and release-fit decisions. Submitted delivery remains frozen."},
  ClaimWork: {description: "Claim assigned research, architecture or prioritization work with a stable requestId; returns the claim token and deterministic context."},
  SaveResultDraft: {description: "Save incomplete findings under the current assigned claim without requesting review."},
  RecordResult: {description: "Submit complete research, architecture or prioritization findings under a claim and request the existing Governance review."},
  PublishResult: {description: "Publish recorded findings as proposed Wiki assertions; does not approve their claims."},
  IntakeWorkPreview: {description: "Preview ready implementation with current discovery sources and release-fit revision. Changes nothing."},
  SubmitIntakeWork: {description: "Submit the reviewed implementation package through existing Foundry contracts and Governance checks. Requires the current preview digest and stable requestId."},
  ResetIntakeSubmission: {description: "Reset a rejected delivery submission at the current intake revision when no delivery record exists."},
  DailyReports:{description:"Read daily report outcomes across authorized Planning scopes, preserving missing source rows for dependency readiness.",collection:true,provenance:"organizationSlug"},
  DailyReport:{description:"Read this owner's exact daily report for a local date, with source coverage, project dependencies and pinned Wiki revision."},
  GenerateDailyReports:{description:"Start the same-owner daily report chain for a completed recovery date or previous local day as one durable registered task; editors only."},
  ProjectDigests:{description:"Read the preserved Planning digest history for a project."},
  GenerateProjectDigest:{description:"Start the registered digest task for one project and save its previous-local-day report; editors only."},
  DigestRuns:{description:"Read daily digest/report run progress and failures."},
  DigestSchedule:{description:"Read the existing daily owner report chain schedule."},
  ChangeDigestSchedule:{description:"Enable or disable the existing daily report chain schedule; editors only."},
  Issues: {description: "Read issues in this installation, filtered by projectId, status or category. Results page in ID order; position gives the category order. Use includeIdentifiers:true for IDs and revisions before changes.", collection: true},
  IssueChanges: {description: "Create, replace, delete or reorder project issues. Use stable UUID item keys for safe retries; read Issues with includeIdentifiers:true first for IDs, current revisions and every issue in a category before reordering. Updates replace fields, so preserve values from the read. Any member of the installation may write."},
  ProjectRepositories:{description:"Read project repositories and their recent GitHub pull requests.",collection:true,provenance:"organizationSlug"},
  PriorityOrder:{description:"Read an organization priority order and revision."},
  PersonalPortfolio:{description:"Read personal organization or cross-organization project order, authorized records and revision. Personal scope only; kind is organizations or projects."},
  ReorderPersonalPortfolio:{description:"Save the complete personal portfolio order at its revision. Personal scope only; shared organization priorities are unchanged."},
  ReorderPriority:{description:"Save the complete priority order at its current revision."},
  SetProjectState:{description:"Change a project lifecycle state using its current revision, including restoring an archived project."},
  GenerateProductReport:{description:"Start the registered product roadmap summary workflow for the selected at date or current week. Editors only."},
  ProductReportRuns:{description:"Read the latest roadmap summary workflow runs and their statuses."},
  ProductReportSchedule:{description:"Read daily product roadmap regeneration schedule and last outcome."},
  ChangeProductReportSchedule:{description:"Enable or disable daily roadmap regeneration at 13:00 UTC. Editors only."},
  Products:{description:"Products and the weekly product roadmap, with projects and goals. at defaults to the current UTC week.",collection:true,provenance:"organizationSlug"},
  ProductSummaries:{description:"The Products page and current weekly roadmap as Markdown. at defaults to the current UTC week.",collection:true,provenance:"organizationSlug",markdown:{title:"name",slug:"slug",body:"markdown"}},
  MutateProject:{description:"Create projects, overlay mask fields on an existing Projects record, or archive. For edits, read Projects with includeIdentifiers:true; send its id/revision in project and only changed fields in mask. Stable item keys make retries safe."},
  ProjectDelivery:{description:"Read a project's delivery handoff: requirements, preparation state and blockers, frozen Workshop/Foundry packages, read-backs and evidence-based milestones."},
  "ProjectSummaries": {description:"Read projects and their linked context as compact Markdown blocks.",collection:true,provenance:"organizationSlug",markdown:{title:"name",slug:"slug"}},
  "OrganizationGoals": {description:"Each organization's goals and the KPIs that measure them, from its Wiki.",collection:true,provenance:"organizationSlug"},
  "Projects": {
    "description": "Find projects with organization slug, use cases, customer segments, user stories, the goals they pursue and their readiness (stage and what is still missing).",
    "collection": true,
    "provenance": "organizationSlug"
  }
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<PlanningContext>(() => graphqlSchema);

/** A page route's write through a mutation document: the document validates `input` and the
 * write answers its one field's value, as the route did before documents. */
export const pageWrite = <Result extends Record<string, unknown>, Variables extends Record<string, unknown>>(document: TadaDocumentNode<Result, Variables>) =>
  async (input: unknown, context: PlanningContext) => Object.values(await runDocument(document, { input } as unknown as Variables, context))[0];
