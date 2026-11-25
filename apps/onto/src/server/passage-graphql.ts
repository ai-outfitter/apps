import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import { fieldError, mutationField, zodInputType } from "@ai-outfitter/app-sdk/app-graphql";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  GraphQLBoolean, type GraphQLFieldConfigMap, GraphQLFloat, GraphQLInt, GraphQLList,
  GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from "graphql";
import { z } from "zod";
import type { passageIndexActions } from "./passage-index";
import { scopeInput } from "./passage-source";

export type PassageGraphContext = Pick<ActionContext, "identity"> & Partial<Omit<ActionContext, "identity">> & {
  host?: () => WorkflowHost<"interactive">;
};

const text = { type: new GraphQLNonNull(GraphQLString) };
const integer = { type: new GraphQLNonNull(GraphQLInt) };
const targetInput = z.strictObject({ wiki: z.strictObject({ installationId: scopeInput.shape.wikiInstallationId }) });
const targetTypeName = "WikiPassageTarget";
const scopeArgs = { wiki: { type: new GraphQLNonNull(zodInputType(targetInput.shape.wiki, targetTypeName)) } };
const limitArg = { type: GraphQLInt, description: "Maximum items, from 1 to 50. Defaults to 20." };

async function invoke(context: PassageGraphContext, action: keyof typeof passageIndexActions, input: object) {
  const { identity, actor, originActor, host } = context;
  if (!actor || !originActor || !host) throw new Response("Wiki access is required", { status: 403 });
  // Load the Worker database binding only while executing a passage operation.
  const { passageIndexActions } = await import("./passage-index");
  return passageIndexActions[action].invoke({ identity, actor, originActor, host }, input);
}

const source = new GraphQLObjectType({ name: "WikiPassageSource", fields: {
  sourceId: text, version: text, pageSlug: text, pageRevision: integer,
  revision: { type: GraphQLInt, description: "Wiki document revision, if present." },
  fileName: { type: GraphQLString }, sha256: { type: GraphQLString }, contentHash: text,
} });

const locator = new GraphQLObjectType({ name: "WikiPassageLocator", fields: {
  kind: text, start: integer, end: integer,
  section: { type: GraphQLString }, page: { type: GraphQLInt },
  startMs: { type: GraphQLFloat }, endMs: { type: GraphQLFloat },
} });

const passage = new GraphQLObjectType({ name: "WikiPassage", fields: {
  id: text, text, source: { type: new GraphQLNonNull(source) }, locator: { type: new GraphQLNonNull(locator) },
} });

const search = new GraphQLObjectType({ name: "WikiPassageSearch", fields: {
  passages: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(passage))) },
  next: { type: GraphQLString, description: "Opaque continuation cursor, or null when exhausted." },
} });

const progress = new GraphQLObjectType({ name: "WikiPassageProgress", fields: {
  cursor: { type: GraphQLString }, updatedAt: { type: GraphQLFloat, description: "Unix time in milliseconds." },
  lastError: { type: GraphQLString }, sweeps: integer, indexedSources: integer, pendingSources: integer,
  sourceIssues: integer, indexedPassages: integer, pendingPassages: integer, inferenceRetries: integer,
  routed: integer, pendingSuggestions: integer, unresolved: integer, routingRetries: integer,
} });

const sourceIssueFields = { sourceId: text, version: text, issue: text };
const sourceIssue = new GraphQLObjectType({ name: "WikiPassageSourceIssue", fields: sourceIssueFields });
const suggestion = new GraphQLObjectType({ name: "WikiPassageHeldSuggestion", fields: {
  ...sourceIssueFields, id: text, passageId: text,
} });
const held = new GraphQLObjectType({ name: "WikiPassageHeldItems", fields: {
  sources: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(sourceIssue))) },
  suggestions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(suggestion))) },
} });

export const passageGraphTypeNames = [
  targetTypeName, ...[source, locator, passage, search, progress, sourceIssue, suggestion, held].map(type => type.name),
];

export const passageQueries: GraphQLFieldConfigMap<unknown, PassageGraphContext> = {
  wikiPassageSearch: {
    type: new GraphQLNonNull(search),
    description: "Search currently readable indexed Wiki passages by case-insensitive substring.",
    args: { ...scopeArgs, query: text, limit: limitArg, after: { type: GraphQLString } },
    resolve: (_root, { wiki, query, limit, after }, context) =>
      invoke(context, "passage.search", { wikiInstallationId: wiki.installationId, query, limit: limit ?? undefined, after: after ?? undefined })
        .catch(async error => { throw await fieldError(error); }),
  },
  wikiPassageProgress: {
    type: new GraphQLNonNull(progress),
    description: "Read durable indexing and routing counters for an accessible Wiki in this organization.",
    args: scopeArgs,
    resolve: (_root, { wiki }, context) => invoke(context, "passage.progress", { wikiInstallationId: wiki.installationId })
      .catch(async error => { throw await fieldError(error); }),
  },
  wikiPassageHeldItems: {
    type: new GraphQLNonNull(held),
    description: "Read current Wiki extraction issues and held suggestions with their reasons.",
    args: { ...scopeArgs, limit: limitArg },
    resolve: (_root, { wiki, limit }, context) =>
      invoke(context, "passage.unresolved", { wikiInstallationId: wiki.installationId, limit: limit ?? undefined })
        .catch(async error => { throw await fieldError(error); }),
  },
};

const schedule = new GraphQLObjectType({ name: "WikiPassageSchedule", fields: {
  id: text, workflowId: text, enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  cron: text, timezone: text, nextRunAt: { type: new GraphQLNonNull(GraphQLFloat) },
} });

export const enableWikiPassageIndex = mutationField({
  name: "EnableWikiPassageIndex", input: targetInput, args: scopeArgs, output: new GraphQLNonNull(schedule),
  description: "As an organization editor, enable the scheduled passage index for an accessible Wiki in this organization.",
  run: (context: PassageGraphContext, { wiki }) => invoke(context, "passage.schedule", { wikiInstallationId: wiki.installationId }),
});
