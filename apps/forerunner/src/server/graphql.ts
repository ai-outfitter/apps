import { batchSchema } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { fieldError, mutationField, type TableContext, tableType } from "@ai-outfitter/app-sdk/app-graphql";
import { and, eq } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  GraphQLBoolean, GraphQLFloat, type GraphQLFieldConfig, GraphQLID, GraphQLList, GraphQLNonNull, type GraphQLNullableType, GraphQLObjectType, GraphQLSchema, GraphQLString,
  getNamedType,
} from "graphql";
import { z } from "zod";
import type { ForerunnerContext } from "./context";
import { createInput, createItem, deleteInput, deleteItem, reorderInput, reorderItems, updateInput, updateItem } from "./items";
import { changeSchedule, scheduleChange } from "./schedule";
import { discoveryRecords, items } from "./schema";
import { listSuggestions, type Suggestion, suggestionInput, updateSuggestion } from "./suggestions";

// Board items and discovery records are private to their member, as in every other
// read here: only the calling member's rows in this installation.
const own = (table: { installationId: SQLiteColumn; ownerId: SQLiteColumn }) => ({ identity }: ActionContext) =>
  and(eq(table.installationId, identity.installationId), eq(table.ownerId, identity.userId));

const board = tableType(items, {
  field: "items", type: "Item",
  fields: ["category", "title", "description", "dueDate", "status", "position", "parentId", "revision", "createdAt", "updatedAt"],
  dates: ["createdAt", "updatedAt"],
  ids: ["parentId"],
  filters: ["category", "status"],
  scope: own(items),
});

/** Runs a query field so a refusal thrown anywhere in it, even reaching the host, keeps its status. */
const refusing = async <T>(run: () => Promise<T>) => {
  try { return await run(); } catch (error) { throw await fieldError(error); }
};
const nonNull = <T extends GraphQLNullableType>(type: T) => new GraphQLNonNull(type);
/** The row type a tableType collection pages (`<Type>Connection.nodes`), so a mutation returns the same record a read does. */
const rowType = (collection: GraphQLFieldConfig<unknown, TableContext>) =>
  getNamedType((getNamedType(collection.type) as GraphQLObjectType).getFields().nodes.type) as GraphQLObjectType;
const item = rowType(board.items);

// The routes name the item in their path; a document names it in the input.
const id = { id: z.uuid() };
const updateItemInput = updateInput.safeExtend(id);
const deleteItemInput = deleteInput.safeExtend(id);
const deletedItem = new GraphQLObjectType({ name: "DeletedItem", fields: { deleted: { type: nonNull(GraphQLID) } } });
const dailyRun = new GraphQLObjectType({ name: "DailyRun", description: "The daily discovery run as Settings shows it; times are epoch milliseconds.", fields: {
  enabled: { type: nonNull(GraphQLBoolean) }, connectionId: { type: GraphQLID }, timezone: { type: GraphQLString },
  nextRunAt: { type: GraphQLFloat }, lastRunAt: { type: GraphQLFloat }, lastOutcome: { type: GraphQLString },
} });
const routineTaskType = new GraphQLObjectType({ name: "RoutineTask", description: "A recurring task: what a routine does each time, when, and how.", fields: {
  title: { type: nonNull(GraphQLString) }, description: { type: nonNull(GraphQLString) }, cadence: { type: GraphQLString },
  steps: { type: nonNull(new GraphQLList(nonNull(GraphQLString))) },
} });
const suggestionType = new GraphQLObjectType<Suggestion>({ name: "Suggestion", description: "Something the daily run suggests: a new workflow to turn on, a change to one of the member's routines, or an app. Status is open, applied or dismissed.", fields: {
  id: { type: nonNull(GraphQLID) }, kind: { type: nonNull(GraphQLString), description: "workflow, change or app" }, status: { type: nonNull(GraphQLString) },
  title: { type: nonNull(GraphQLString) }, why: { type: nonNull(GraphQLString) },
  routineId: { type: GraphQLID, description: "change only: the routine it rewrites, its routine id in platform Schedules" },
  routineName: { type: GraphQLString }, task: { type: routineTaskType, description: "workflow: the routine to turn on; change: the routine's whole new task" },
  appName: { type: GraphQLString, resolve: (suggestion) => suggestion.app?.name ?? null },
  appGoal: { type: GraphQLString, resolve: (suggestion) => suggestion.app?.goal ?? null },
  createdAt: { type: nonNull(GraphQLString) },
} });
const suggestionStatuses = z.array(z.enum(["open", "applied", "dismissed"])).min(1).max(3).default(["open"]);

const revisioned = "Send the revision last read; a stale one is refused (409) so a change you have not seen is never overwritten.";
// Forerunner's writes, each the domain function its route runs. Every member writes their
// own private board, so graph.mutate admits members; the daily run requires an editor itself.
const mutation = new GraphQLObjectType<unknown, ForerunnerContext>({
  name: "Mutation",
  fields: {
    createItem: mutationField<typeof createInput, ForerunnerContext>({
      name: "CreateItem",
      description: "Add a stone (a top priority), a pebble (a stone's next action, parentId required) or sand (a small task, optionally under a stone) to the caller's board, last in its category. Status is todo, in-progress or done; dueDate an ISO date. At most 500 items.",
      input: createInput, output: nonNull(item),
      run: (context, input) => createItem(context.db(), context.identity, input),
    }),
    updateItem: mutationField<typeof updateItemInput, ForerunnerContext>({
      name: "UpdateItem",
      description: `Replace one of the caller's items: its category, title, description, dueDate, status (done completes it, todo reopens it) and parentId. ${revisioned}`,
      input: updateItemInput, output: nonNull(item),
      run: (context, { id, ...input }) => updateItem(context.db(), context.identity, id, input),
    }),
    deleteItem: mutationField<typeof deleteItemInput, ForerunnerContext>({
      name: "DeleteItem",
      description: `Delete one of the caller's items. A stone with pebbles or sand under it is refused until they move. ${revisioned}`,
      input: deleteItemInput, output: nonNull(deletedItem),
      run: (context, { id, revision }) => deleteItem(context.db(), context.identity, id, { revision }),
    }),
    reorderItems: mutationField<typeof reorderInput, ForerunnerContext>({
      name: "ReorderItems",
      description: `Rank one whole category of the caller's board, completed items included, in the order given; nothing moves unless every item is named at its revision. Returns the board. ${revisioned}`,
      input: reorderInput, output: nonNull(new GraphQLList(nonNull(item))),
      run: (context, input) => reorderItems(context.db(), context.identity, input),
    }),
    updateSuggestion: mutationField<typeof suggestionInput, ForerunnerContext>({
      name: "UpdateSuggestion",
      description: "Act on an open suggestion by its status. `applied` turns a workflow suggestion on as a routine (its first run starts now, in `timezone`) or rewrites a change's routine; `dismissed` sets it aside so later runs do not suggest it again. App suggestions are built from Apps, so they can only be dismissed here. Editors only.",
      input: suggestionInput, output: nonNull(suggestionType),
      run: (context, input) => updateSuggestion(context.db(), context.identity, context.host(), input),
    }),
    setDailyRun: mutationField<typeof scheduleChange, ForerunnerContext>({
      name: "SetDailyRun",
      description: "Turn the daily discovery run on, reading one connected Gmail or Calendar account (source `connection:<id>`, as the sources page lists them) in the given time zone, or off. Editors only.",
      input: scheduleChange, output: nonNull(dailyRun),
      run: (context, input) => changeSchedule(context.host(), context.identity, input),
    }),
  },
});

/** What this app serves over graph.graphql and graph.mutate (printed to graph/schema.graphql
 * by scripts/graph-schema.ts): the caller's board items and discovery records, and the writes
 * its documents (src/server/documents.ts) run. A discovery record's data (source samples and
 * proposals) is not served. */
const baseGraphqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      ...board,
      ...tableType(discoveryRecords, {
        field: "discoveryRecords", type: "DiscoveryRecord",
        fields: ["kind", "createdAt"],
        dates: ["createdAt"],
        filters: ["kind"],
        scope: own(discoveryRecords),
      }),
      suggestions: {
        type: nonNull(new GraphQLList(nonNull(suggestionType))),
        description: "What the daily runs suggest, newest first: open suggestions unless `status` names others (applied, dismissed). Editors only.",
        args: { status: { type: new GraphQLList(nonNull(GraphQLString)) } },
        resolve: (_source: unknown, args: { status?: string[] | null }, context: ForerunnerContext) =>
          refusing(() => listSuggestions(context.db(), context.identity, suggestionStatuses.parse(args.status ?? undefined))),
      },
    },
  }),
  mutation,
});

export const graphqlSchema = batchSchema(baseGraphqlSchema, batchGroups);
