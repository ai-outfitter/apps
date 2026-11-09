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
  Suggestions: { description: "Read the open suggestions from the member's daily Forerunner run: a workflow to turn on, a change to one of their routines (routineId is the routine in platform Schedules), or an app to build." },
  SuggestionChanges: { description: "Act on suggestions from Suggestions with action update and a status: applied turns a workflow on or rewrites the routine it changes, dismissed sets it aside. An app suggestion is built from Apps, so it can only be dismissed here." },
});

/** Run one of these documents in process, as a page or route does (documentRunner). */
export const runDocument = documentRunner<ForerunnerContext>(() => graphqlSchema);
