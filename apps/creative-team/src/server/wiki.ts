// The brand interview in the member's Wiki (knowledge graph). The interview is saved as one
// BrandInterview document whose body follows a JSON Schema the Wiki validates, and the people,
// audience, problems, offerings and goals the answers name become Wiki records linked to it.
// Nothing is written directly: everything is staged as one Wiki change batch and submitted, so
// the member (and the Wiki's ontology steward) review it on the Wiki's Changes page.
import { z } from "zod";
import { schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
import { graphGraphqlResult, graphMutateAction } from "@ai-outfitter/app-sdk/app-graphql";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph, stableGraphId, wikiAdapter } from "@ai-outfitter/onto/client";
import { wikiChangeDocuments, wikiGraph } from "@ai-outfitter/onto/contracts";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { desc, eq } from "drizzle-orm";
import { brandQuestionIds, brandSections } from "../lib/brand";
import { wikiBatches } from "./schema";
import { type Database, readState, requireWriter } from "./store";

type Host = WorkflowHost<"interactive">;
const conflict = (message: string) => new Response(message, { status: 409 });

/** A Wiki record the interview names: an existing one (existingId) or one this batch creates. */
const nodeRef = (title: string) => z.uuid().meta({ "x-wiki-reference": "node", title });

/** The BrandInterview body. Answers stay in the member's words; mentions point at Wiki records. */
export const interviewDocument = z.strictObject({
  schemaVersion: z.literal(1),
  subject: nodeRef("Whose brand").describe("The Person whose brand this is: the member."),
  sections: z.array(z.strictObject({
    id: z.string().max(64),
    title: z.string().max(200),
    answers: z.array(z.strictObject({
      questionId: z.string().max(64),
      question: z.string().max(500),
      answer: z.string().max(8000).describe("The member's answer, in their own words."),
      mentions: z.array(nodeRef("Mentioned record")).max(20).describe("Wiki records this answer names: people, audiences, problems, offerings, goals."),
    })).max(40),
  })).max(20),
});
export type InterviewDocument = z.infer<typeof interviewDocument>;

/** Stable IDs: the same in every Wiki, so setup is add-only and repeatable. */
export const wikiTypeIds = {
  interview: "c7ea0000-0000-4000-8000-000000000101",
  interviewOf: "c7ea0000-0000-4000-8000-000000000102",
  mentions: "c7ea0000-0000-4000-8000-000000000103",
  influencedBy: "c7ea0000-0000-4000-8000-000000000104",
  servesAudience: "c7ea0000-0000-4000-8000-000000000105",
} as const;
const edgeType = (id: string, name: string, title: string, body: string, from: string[], to: string[] | "any") =>
  ({ id, category: "edge" as const, name, title, body, properties: [], ontology: { version: 2 as const, endpoints: { from, to } } });
export const brandWikiTypes = wikiGraph.parse({
  types: [
    { id: wikiTypeIds.interview, category: "node", name: "BrandInterview", title: "Brand interview", properties: [], jsonSchema: schemaJSON(interviewDocument),
      body: "A member's personal brand interview from the Creative team app: their answers to the intellectual-signature questions, in their own words, with the people, audiences, problems, offerings and goals each answer names." },
    edgeType(wikiTypeIds.interviewOf, "brand_interview_of", "Brand interview of", "The Person whose brand the interview describes.", [wikiTypeIds.interview], ["71000000-0000-4000-8000-000000000005"]),
    edgeType(wikiTypeIds.mentions, "brand_interview_mentions", "Mentioned in brand interview", "A record the member named in a brand interview answer. Says the member mentioned it, nothing more.", [wikiTypeIds.interview], ["71000000-0000-4000-8000-000000000005", "71000000-0000-4000-8000-000000000016", "71000000-0000-4000-8000-000000000017", "71000000-0000-4000-8000-000000000056", "71000000-0000-4000-8000-000000000010"]),
    edgeType(wikiTypeIds.influencedBy, "influenced_by", "Influenced by", "A person whose work shaped this person's thinking, as they said themselves.", ["71000000-0000-4000-8000-000000000005"], ["71000000-0000-4000-8000-000000000005"]),
    edgeType(wikiTypeIds.servesAudience, "serves_audience", "Serves audience", "An audience this person makes content and offers for, as they described it.", ["71000000-0000-4000-8000-000000000005"], ["71000000-0000-4000-8000-000000000016"]),
  ],
  nodes: [], edges: [],
});

/** The Wiki types an interview may name, by their names in the default ontology. */
export const entityKinds = ["Person", "CustomerSegment", "Problem", "Offering", "Goal"] as const;
export type EntityKind = (typeof entityKinds)[number];
const relations = { influenced_by: wikiTypeIds.influencedBy, serves_audience: wikiTypeIds.servesAudience } as const;
const relationKinds: Record<keyof typeof relations, EntityKind> = { influenced_by: "Person", serves_audience: "CustomerSegment" };

const entity = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Your short stable name for this record, e.g. naval-ravikant. Reuse it to change the same record later."),
  existingId: z.uuid().optional().describe("An existing Wiki record of this kind to reuse instead of creating one (from creative_team_wiki_read)."),
  kind: z.enum(entityKinds),
  title: z.string().trim().min(1).max(160).describe("Its name as the member said it."),
  summary: z.string().trim().max(280).default("").describe("One line on who or what it is, from the member's words."),
  questionIds: z.array(z.enum(brandQuestionIds)).min(1).max(28).describe("The answers that name it."),
  relation: z.enum(["influenced_by", "serves_audience"]).optional()
    .describe("influenced_by: a Person who shaped the member's thinking. serves_audience: a CustomerSegment the member makes content for."),
});
export const stageInput = z.strictObject({
  self: z.strictObject({
    existingId: z.uuid().optional().describe("The member's own Person record in the Wiki, if there is one (creative_team_wiki_read lists people)."),
    title: z.string().trim().min(1).max(160).optional().describe("The member's name, to create their Person record when the Wiki has none."),
  }).refine((value) => value.existingId || value.title, "Name the member's Person record or their name"),
  entities: z.array(entity).max(60).default([]),
});

/** Wiki records of the kinds an interview names, for reuse before creating new ones. */
export async function wikiCandidates(host: Host) {
  const graph = await readWikiGraph(host);
  const kinds = new Map(graph.types.filter((type) => (entityKinds as readonly string[]).includes(String(type.attributes.name))).map((type) => [type.ref.id, String(type.attributes.name)]));
  const interview = graph.nodes.find((node) => node.attributes.typeId === wikiTypeIds.interview && !node.attributes.archived);
  return {
    wiki: { writable: graph.wiki.writable, path: wikiPath(graph.wiki) },
    missingKinds: entityKinds.filter((kind) => ![...kinds.values()].includes(kind)),
    records: graph.nodes.filter((node) => kinds.has(String(node.attributes.typeId)) && !node.attributes.archived).slice(0, 400)
      .map((node) => ({ id: node.ref.id, kind: kinds.get(String(node.attributes.typeId)), title: node.title, summary: String(node.attributes.summary ?? "") })),
    interview: interview ? { id: interview.ref.id, revision: interview.revision } : null,
  };
}

const wikiPath = (wiki: { hostname: string | null; slug: string }) => (wiki.hostname ? `https://${wiki.hostname}/` : `/apps/${wiki.slug}/`);

type Operation = { operation: "create"; ref: string; type: "graph-node" | "graph-edge"; attributes: Record<string, unknown> }
  | { operation: "update"; ref: string; type: "graph-node"; id: string; revision: number; attributes: Record<string, unknown> };
type Proposal = { operation: Operation; evidence: { provider: string; recordId: string; quote?: string }[]; confidence: number; reason: string };

/** Run one of the Wiki's change-batch documents through its graph.mutate action. */
async function wikiMutate<T>(host: Host, installationId: string, name: "StageChanges" | "SubmitBatch", input: Record<string, unknown>) {
  const result = graphGraphqlResult.parse(await host.call("actions.call", {
    installationId, action: graphMutateAction,
    input: { query: wikiChangeDocuments[name].document, operationName: name, variables: { input } } as never,
  }));
  const error = result.errors?.[0];
  if (error || !result.data) throw new Response(error?.message ?? `${name} returned no data`, { status: Number(error?.extensions?.status ?? 422) });
  return result.data as T;
}

const parseJSON = (value: unknown) => { try { return JSON.parse(String(value)); } catch { return null; } };

type Batch = { id: string; state: string; counts: Record<string, number> };

/** The interview document from the answers saved in the app, with each answer's mentions. */
function interviewBody(answers: Map<string, string>, subject: string, mentions: Map<string, string[]>): InterviewDocument {
  return interviewDocument.parse({
    schemaVersion: 1, subject,
    sections: brandSections.map((section) => ({
      id: section.id, title: section.title,
      answers: section.questions.filter((question) => answers.get(question.id)?.trim()).map((question) => ({
        questionId: question.id, question: question.text, answer: answers.get(question.id) ?? "", mentions: [...new Set(mentions.get(question.id) ?? [])].slice(0, 20),
      })),
    })).filter((section) => section.answers.length),
  });
}

/**
 * Stage the interview and what it names as one Wiki change batch and submit it for review.
 * The member's own Person, each named record (reused or created), the BrandInterview document
 * (created, or updated at its current revision) and the links between them. Records and links
 * the Wiki already has are not proposed again.
 */
export async function stageInterview(db: Database, identity: AppIdentity, host: Host, raw: z.input<typeof stageInput>, now = Date.now()) {
  requireWriter(identity);
  const input = stageInput.parse(raw);
  const answers = new Map((await readState(db)).answers.filter((row) => row.answer.trim()).map((row) => [row.id, row.answer]));
  if (!answers.size) throw conflict("Answer at least one interview question first");
  const graph = await readWikiGraph(host);
  if (!graph.wiki.writable) throw new Response("Your Wiki is not writable", { status: 403 });
  // Records a batch still waiting for review would create must not be proposed twice.
  const [last] = await recentBatches(db);
  if (last && last.wikiInstallationId === graph.wiki.installationId && (await batchState(host, last.wikiInstallationId, last.id, db)) === "awaiting_review")
    throw conflict("Your last brand interview batch is still waiting for review in your Wiki. Review it there first.");
  const wikiId = graph.wiki.installationId;
  await wikiAdapter(host, wikiId).setup(brandWikiTypes);

  const typeByName = new Map(graph.types.filter((type) => !type.attributes.archived).map((type) => [String(type.attributes.name), type.ref.id]));
  const nodes = new Map(graph.nodes.filter((node) => !node.attributes.archived).map((node) => [node.ref.id, node]));
  const kindType = (kind: EntityKind) => typeByName.get(kind) ?? (() => { throw conflict(`Your Wiki has no ${kind} type`); })();
  const existing = (id: string, kind: EntityKind) => {
    const node = nodes.get(id);
    if (!node || node.attributes.typeId !== kindType(kind)) throw conflict(`${id} is not an active ${kind} in your Wiki`);
    return node;
  };
  const owner = identity.organizationId ?? identity.userId;
  const proposals: Proposal[] = [];
  const evidence = (questionIds: string[]) => questionIds.filter((id) => answers.has(id)).slice(0, 8)
    .map((id) => ({ provider: "creative-team", recordId: `${identity.installationId}/brand-interview/${id}`, quote: (answers.get(id) ?? "").slice(0, 2000) }));
  // A record created in this batch is linked by its ref: it exists only once the batch commits.
  const refs = new Map<string, string>();
  const create = (ref: string, type: "graph-node" | "graph-edge", attributes: Record<string, unknown>, questionIds: string[], reason: string) => {
    if (type === "graph-node") refs.set(String(attributes.id), ref);
    proposals.push({ operation: { operation: "create", ref, type, attributes }, evidence: evidence(questionIds), confidence: 1, reason });
  };

  // The member.
  const allQuestions = [...answers.keys()];
  const selfId = input.self.existingId ? existing(input.self.existingId, "Person").ref.id : await stableGraphId("creative-team-self-v1", wikiId, owner);
  if (!nodes.has(selfId)) create("$self", "graph-node", { id: selfId, typeId: kindType("Person"), title: input.self.title }, allQuestions, "The member whose brand the interview describes.");

  // What the answers name.
  const mentions = new Map<string, string[]>();
  const named: { id: string; relation?: keyof typeof relations; kind: EntityKind; questionIds: string[] }[] = [];
  const keys = new Set<string>();
  for (const item of input.entities) {
    if (keys.has(item.key)) throw new Response(`Duplicate key ${item.key}`, { status: 400 });
    keys.add(item.key);
    if (item.relation && relationKinds[item.relation] !== item.kind) throw new Response(`${item.relation} links to a ${relationKinds[item.relation]}`, { status: 400 });
    const id = item.existingId ? existing(item.existingId, item.kind).ref.id : await stableGraphId("creative-team-entity-v1", wikiId, owner, item.key);
    if (id === selfId) throw new Response("The member is self, not an entity", { status: 400 });
    if (!nodes.has(id)) create(`$${item.key}`, "graph-node", { id, typeId: kindType(item.kind), title: item.title, summary: item.summary }, item.questionIds, `Named by the member in the brand interview (${item.questionIds.join(", ")}).`);
    for (const questionId of item.questionIds) mentions.set(questionId, [...(mentions.get(questionId) ?? []), id]);
    named.push({ id, relation: item.relation, kind: item.kind, questionIds: item.questionIds });
  }

  // The interview document. Records earlier saves linked to an answer stay linked while they are active.
  const interviewId = await stableGraphId("creative-team-brand-interview-v1", wikiId, owner);
  const previous = interviewDocument.safeParse(parseJSON(nodes.get(interviewId)?.attributes.body));
  for (const answer of previous.success ? previous.data.sections.flatMap((section) => section.answers) : [])
    mentions.set(answer.questionId, [...answer.mentions.filter((id) => nodes.has(id)), ...(mentions.get(answer.questionId) ?? [])]);
  const body = JSON.stringify(interviewBody(answers, selfId, mentions));
  const title = `Brand interview: ${input.self.title ?? nodes.get(selfId)?.title ?? "member"}`;
  const saved = nodes.get(interviewId);
  if (!saved) create("$interview", "graph-node", { id: interviewId, typeId: wikiTypeIds.interview, title, summary: `${answers.size} answered questions`, body }, allQuestions, "The member's brand interview, in their own words.");
  else if (saved.attributes.body !== body)
    proposals.push({ operation: { operation: "update", ref: "$interview", type: "graph-node", id: interviewId, revision: saved.revision, attributes: { body, summary: `${answers.size} answered questions` } },
      evidence: evidence(allQuestions), confidence: 1, reason: "The member's brand interview, updated with their latest answers." });

  // The links, unless the Wiki has them already.
  const edges = new Set(graph.edges.filter((edge) => !edge.attributes.archived).map((edge) => `${edge.attributes.typeId}:${edge.attributes.fromId}:${edge.attributes.toId}`));
  const link = async (typeId: string, fromId: string, toId: string, questionIds: string[], reason: string) => {
    if (edges.has(`${typeId}:${fromId}:${toId}`)) return;
    edges.add(`${typeId}:${fromId}:${toId}`);
    const id = await stableGraphId("wiki-link-v1", wikiId, typeId, fromId, toId);
    create(`$edge-${proposals.length}`, "graph-edge", { id, typeId, fromId: refs.get(fromId) ?? fromId, toId: refs.get(toId) ?? toId }, questionIds, reason);
  };
  await link(wikiTypeIds.interviewOf, interviewId, selfId, allQuestions, "The interview describes the member's brand.");
  for (const item of named) {
    await link(wikiTypeIds.mentions, interviewId, item.id, item.questionIds, "The member named it in the brand interview.");
    if (item.relation) await link(relations[item.relation], selfId, item.id, item.questionIds, item.relation === "influenced_by" ? "The member said this person shaped their thinking." : "The member said they make content for this audience.");
  }
  if (!proposals.length) return { batch: null, wikiPath: wikiPath(graph.wiki), proposals: 0 };

  // One batch: stage in pages of 100, then submit for review.
  let batch: Batch | undefined;
  for (let i = 0; i < proposals.length; i += 100) {
    const page = proposals.slice(i, i + 100);
    const staged = await wikiMutate<{ stageChanges: Batch }>(host, wikiId, "StageChanges", batch
      ? { batchId: batch.id, proposals: page }
      : { title, purpose: "Save the member's brand interview and the people, audiences, problems, offerings and goals it names.", proposals: page });
    batch = staged.stageChanges;
  }
  const submitted = (await wikiMutate<{ submitBatch: Batch }>(host, wikiId, "SubmitBatch", { batchId: batch!.id, summary: `${proposals.length} changes from the brand interview` })).submitBatch;
  const path = wikiPath(graph.wiki);
  await db.insert(wikiBatches).values({ id: submitted.id, wikiInstallationId: wikiId, wikiPath: path, state: submitted.state, proposals: proposals.length, createdBy: identity.userId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: wikiBatches.id, set: { state: submitted.state, proposals: proposals.length, updatedAt: now } });
  return { batch: { id: submitted.id, state: submitted.state, counts: submitted.counts }, wikiPath: path, proposals: proposals.length };
}

/** A batch's current state, read from the Wiki and kept on its row. Null when the Wiki no longer has it. */
export async function batchState(host: Host, wikiInstallationId: string, batchId: string, db?: Database) {
  const result = graphGraphqlResult.parse(await host.call("actions.call", {
    installationId: wikiInstallationId, action: "graph.graphql", readOnly: true,
    input: { query: wikiChangeDocuments.ChangeBatch.document, operationName: "ChangeBatch", variables: { id: batchId } } as never,
  }));
  const state = (result.data as { changeBatch: { state: string } | null } | null)?.changeBatch?.state ?? null;
  if (db && state) await db.update(wikiBatches).set({ state, updatedAt: Date.now() }).where(eq(wikiBatches.id, batchId));
  return state;
}

/** The batches this app staged, newest first. */
export const recentBatches = (db: Database) => db.select().from(wikiBatches).orderBy(desc(wikiBatches.createdAt)).limit(5);

export type { EntityRecord };
