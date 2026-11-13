import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
// Forerunner's documents: every named query and mutation its pages and agents run over
// graphqlSchema, each with the user story that keeps it. scripts/graph-schema.ts writes
// them to graph/documents.json, which the platform lists (graph_documents) and runs by
// name (graph_query, graph_mutate); a page route runs the same document with runDocument.
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { documentRunner } from "@ai-outfitter/app-sdk/app-graphql";
import { graphql } from "../../graph/graphql";
import type { ForerunnerContext } from "./context";
import { graphqlSchema } from "./graphql";

const legacyDocuments = defineDocuments({
  DailyHome: { story: "As a member, I want the saved daily roll-up and last week's actual reports on my homepage, with source gaps and a stable Wiki revision, so that I can review progress without triggering jobs.", document: graphql(`query DailyHome($input:DailyHomeInput!){dailyHome(input:$input)}`) },
  DailyBriefSchedule: { story: "As a member, I want to see when my personal brief runs, so that I can inspect it without changing its schedule.", document: graphql(`query DailyBriefSchedule($input:JSON!){dailyBriefSchedule(input:$input)}`) },
  SetDailyBriefSchedule: { story: "As a member, I want one standard daily briefing schedule in my timezone, so that I can enable or disable it explicitly.", document: graphql(`mutation SetDailyBriefSchedule($input:SetDailyBriefScheduleInput!){setDailyBriefSchedule(input:$input)}`) },
  GenerateDailyBrief: { story: "As a member, I want to explicitly refresh my personal daily Wiki brief from authorized saved sources, so that I can see current priorities and coverage gaps.", document: graphql(`mutation GenerateDailyBrief($input:GenerateDailyBriefInput!){generateDailyBrief(input:$input)}`) },
  DayReview: { story: "As a member, I want yesterday’s completed board tasks and saved reports across my organizations, with earlier dates and source coverage, so that I can review progress without starting new work.", document: graphql(`query DayReview($input:DayReviewInput!){dayReview(input:$input)}`) },
  PlanningCandidates: {
    story: "As a member, I want current canonical need identities from my saved discovery, so that I can choose a corrected and reviewed finding for Planning without copying private mail.",
    document: graphql(`query PlanningCandidates($input: PlanningCandidatesInput!) { planningCandidates(input: $input) }`),
  },
  CreatePlanningIntake: {
    story: "As a member, I want to confirm one discovered need into my selected owner-scoped Planning installation, so that existing governed intake takes over with source provenance and safe retries.",
    document: graphql(`mutation CreatePlanningIntake($input: CreatePlanningIntakeInput!) { createPlanningIntake(input: $input) }`),
  },
  Board: {
    hidden:true,
    story: "As an agent, I want the member's unfinished board items with their revisions, so that I can add to, complete or reorder their board without overwriting a change they made.",
    // A board holds at most 500 items, so one page is the whole board.
    document: graphql(`query Board {
      items(first: 500, status: ["todo", "in-progress"]) { nodes { id category title dueDate status position parentId revision } }
    }`),
  },
  CreateItem: {
    story: "As a member, I want to add a stone, pebble or grain of sand from the board or an agent, so that every priority and next action lands on my private board in one way.",
    document: graphql(`mutation CreateItem($input: CreateItemInput!) { createItem(input: $input) { id category title description dueDate status position parentId revision updatedAt } }`),
  },
  UpdateItem: {
    story: "As a member, I want to edit, complete or reopen one of my items at the revision I last saw, so that my board stays current without losing a change I have not seen.",
    document: graphql(`mutation UpdateItem($input: UpdateItemInput!) { updateItem(input: $input) { id category title description dueDate status position parentId revision updatedAt } }`),
  },
  DeleteItem: {
    story: "As a member, I want to delete one of my items at the revision I last saw, so that finished or mistaken work leaves my board.",
    document: graphql(`mutation DeleteItem($input: DeleteItemInput!) { deleteItem(input: $input) { deleted } }`),
  },
  ReorderItems: {
    story: "As a member, I want to rank a whole category of my board in one move, so that the order I work in is saved all at once or not at all.",
    document: graphql(`mutation ReorderItems($input: ReorderItemsInput!) { reorderItems(input: $input) { id category position revision } }`),
  },

  Suggestions: {
    story: "As an agent, I want the open suggestions from the member's daily run, so that I can tell them what to turn on, change or build next and apply or dismiss one when they ask.",
    document: graphql(`query Suggestions {
      suggestions { id kind title why routineId routineName task { title description cadence steps } appName appGoal createdAt }
    }`),
  },
  UpdateSuggestion: {
    story: "As a member or agent, I want to act on a suggestion in one step, turning on a suggested workflow, applying a suggested change to one of my routines, or setting it aside, so that what the daily run noticed starts working for me or stops being suggested.",
    document: graphql(`mutation UpdateSuggestion($input: UpdateSuggestionInput!) { updateSuggestion(input: $input) { id status } }`),
  },




  SetDailyRun: {
    hidden: true,
    story: "As an editor, I want to turn the daily discovery run on or off and choose the account it reads, so that Forerunner reads my mail or calendar each morning only when I want it to.",
    document: graphql(`mutation SetDailyRun($input: SetDailyRunInput!) {
      setDailyRun(input: $input) { enabled connectionId timezone nextRunAt lastRunAt lastOutcome }
    }`),
  },
});

// Only these reach MCP clients; the rest serve Forerunner's own pages. Workflows,
// schedules and runs are the platform's documents (Schedules, ScheduleChanges,
// WorkflowRuns, WorkflowRunChanges), which the Workflows page runs too.
export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), {
  DailyHome: { description: "Read saved personal daily brief, board priorities and yesterday's saved project and organization reports. Set includeHistory:true to load each day of the previous full Monday-Sunday week. Pass sections (digest, priorities, review, history) to read only those: digest alone returns today's saved brief, its Wiki revision and briefState (saved, missing or unavailable) with latestBrief as the last dated snapshot when today's is missing, without waiting on reports. Uses the saved schedule timezone, or UTC until configured. Missing sources are explicit; no job starts." },
  DailyBriefSchedule: { description: "Read the saved daily brief schedule. Does not create or enable schedules." },
  SetDailyBriefSchedule: { description: "Enable or disable Forerunner's 05:00 daily personal Wiki brief in the selected timezone. The run reads saved Planning reports, the board, saved goals, the saved role and saved discovery suggestions; raw mail and analytics adapters are not enabled." },
  GenerateDailyBrief: { description: "Write today's personal Wiki brief now: one model answer over saved, authorized evidence (reports, priorities, goals, role, saved discovery suggestions), each statement citing its source. Records a workflow run and the exact Wiki revision. Unchanged evidence reuses the saved revision; a failed or invalid answer returns status failed with a reason and leaves the saved brief untouched. Missing sources are listed, never inferred." },
  DayReview: { description: "Read a completed day’s board completion events and saved cross-organization daily reports in personal priority order. Optional date defaults to yesterday; timezone defaults to America/Chicago. Missing reports and partial coverage are explicit; no generation starts." },
  PlanningCandidates: { description: "Read canonical saved needs from a private discovery preview before selecting a Planning handoff. Returns current corrected IDs and revisions, never source email samples." },
  CreatePlanningIntake: { description: "After explicit confirmation, capture the selected canonical need using existing Planning CreateIntake in the same owner scope. Read PlanningCandidates first; pass its current expectedId/revision and confirmDestination:true. Does not create a new project, choose release fit, or move personal findings into an organization." },
  Suggestions: { description: "Read the open suggestions from the member's daily Forerunner run: a workflow to turn on, a change to one of their routines (routineId is the routine in platform Schedules), or an app to build." },
  SuggestionChanges: { description: "Act on suggestions from Suggestions with action update and a status: applied turns a workflow on or rewrites the routine it changes, dismissed sets it aside. An app suggestion is built from Apps, so it can only be dismissed here." },
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<ForerunnerContext>(() => graphqlSchema);
