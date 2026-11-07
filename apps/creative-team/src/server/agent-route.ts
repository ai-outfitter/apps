import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import type { AgentRoute } from "@ai-outfitter/app-sdk/agent-page";
import { agentDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { ProposalStore } from "@ai-outfitter/app-sdk/proposal-store";
import { respond } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { brandQuestions, brandSections, mapTargets } from "../lib/brand";
import { type CreativeContext, creativeContext } from "./context";
import {
  addBranch, answerInput, branchInput, draftInput, levelCounts, mapTree, type MapTreeNode, nodeInput, profileInput, readState, saveAnswer, saveDraft, saveNode,
  saveProfile, saveSource, sourceInput,
} from "./store";

export const focusId = "c7ea0000-0000-4000-8000-000000000001";

// One agent plays the three roles of a one-person creative team. The brand strategist
// owns positioning, the content strategist proposes what to post, and the writer drafts.
export const instructions = [
  "You are the member's creative team for their personal brand, playing three roles.",
  "Brand strategist: you own positioning and perception. Build the brand document by interviewing the member with the brand questions: ask one unanswered question at a time, in order unless they pick another, dig for specifics (real people, exact words, concrete stories), and propose saving their answer in their own words with creative_team_brand_answer. Never write an answer they did not give. Growth never comes at the expense of trust and authority, and a brand is built over 6 to 12 months of posts, not one post.",
  "Content strategist: build the content document and the content map. For the content document, ask for the member's best 10 to 20 posts on each platform they post on, or, if they have not posted yet, the 5 to 10 people who shaped their thinking most; record each as a source, and note the core ideas that make them unique, the parts of the voice with personality, and the worldview people could rally behind, plus patterns that are replicable. For the content map, read the brand and content documents, pull 3 to 4 broad pillars and the member's lens from them, then propose branches: 5 to 7 topics per pillar, 5 to 10 ideas per topic, 4 to 5 angles per idea. Ideas should be likely to perform and seen through the member's own lens. In research, say what each idea is based on and where that came from (a post the member pasted, a pattern you know from public content, a source in their Wiki). You have no live view of what is performing on social platforms and no view counts: never invent numbers or claim data you do not have; say when the member should check a platform themselves.",
  "Writer: draft posts, threads, articles, newsletters and video scripts from map ideas and angles, in the member's voice from the content document, aligned with the brand document. Drafts are almost there, for the member to review and rewrite; propose them with creative_team_draft_save and never claim anything was posted.",
  "Read the documents with the read tools before relying on them. Keep replies short, and tell the member which page to review a proposal on.",
].join(" ");

const routes: AgentRoute[] = [
  { path: "", description: "Overview: progress through the brand, content, map and drafts." },
  { path: "brand", description: "The brand interview and its answers (the brand document)." },
  { path: "content", description: "The content document: sources and the voice, ideas and worldview they share." },
  { path: "map", description: "The content map: pillars, topics, ideas and angles." },
  { path: "drafts", description: "Post drafts written from the map." },
];

const outline = (nodes: MapTreeNode[], depth: number): unknown[] =>
  nodes.map(({ id, level, title, notes, research, revision, children }) => ({
    id, level, title, revision, ...(notes ? { notes } : {}), ...(research ? { research } : {}),
    ...(children.length ? depth > 0 ? { children: outline(children, depth - 1) } : { childCount: children.length } : {}),
  }));

const json = z.json();
const actions = publishActionTools("creative-team", {
  "brand.read": defineAction({
    description: "Read the brand document: every interview question with the member's answer (empty when not answered yet) and the answer's revision.",
    access: "read", input: z.strictObject({}), output: json,
    run: async (context: CreativeContext) => {
      const answers = new Map((await readState(context.db())).answers.map((row) => [row.id, row]));
      return brandSections.map((section) => ({
        section: section.title,
        questions: section.questions.map((question) => {
          const answer = answers.get(question.id);
          return { questionId: question.id, question: question.text, ...(question.hint ? { hint: question.hint } : {}), answer: answer?.answer ?? "", ...(answer ? { revision: answer.revision } : {}) };
        }),
      }));
    },
  }),
  "content.read": defineAction({
    description: "Read the content document: every source (own posts or influences) with pasted examples and notes, and the synthesis of core ideas, voice, worldview and patterns.",
    access: "read", input: z.strictObject({}), output: json,
    run: async (context: CreativeContext) => {
      const state = await readState(context.db());
      return {
        sources: state.sources.map(({ id, kind, name, platform, handle, url, examples, notes, revision }) => ({ id, kind, name, platform, handle, url, examples, notes, revision })),
        profile: state.profile ? { coreIdeas: state.profile.coreIdeas, voice: state.profile.voice, worldview: state.profile.worldview, patterns: state.profile.patterns, revision: state.profile.revision } : null,
      };
    },
  }),
  "map.read": defineAction({
    description: "Read the content map as a tree with ids and revisions. Without nodeId, pillars down to ideas (angles counted); with nodeId, that node and everything below it.",
    access: "read", input: z.strictObject({ nodeId: z.string().max(64).optional() }), output: json,
    run: async (context: CreativeContext, input) => {
      const state = await readState(context.db());
      const tree = mapTree(state.nodes);
      if (!input.nodeId) return { counts: levelCounts(state.nodes), targets: mapTargets, pillars: outline(tree, 2) };
      const find = (nodes: MapTreeNode[]): MapTreeNode | undefined => nodes.reduce<MapTreeNode | undefined>((found, node) => found ?? (node.id === input.nodeId ? node : find(node.children)), undefined);
      const node = find(tree);
      if (!node) throw new Response("Map node not found", { status: 404 });
      return outline([node], 3)[0];
    },
  }),
  "drafts.read": defineAction({
    description: "Read drafts: without id, the latest 50 with title, format, status and the map node they came from; with id, one draft's full body.",
    access: "read", input: z.strictObject({ id: z.string().max(64).optional() }), output: json,
    run: async (context: CreativeContext, input) => {
      const rows = (await readState(context.db())).drafts;
      if (input.id) {
        const row = rows.find((draft) => draft.id === input.id);
        if (!row) throw new Response("Draft not found", { status: 404 });
        return { id: row.id, nodeId: row.nodeId, format: row.format, title: row.title, body: row.body, status: row.status, revision: row.revision };
      }
      return rows.slice(0, 50).map(({ id, nodeId, format, title, status, revision }) => ({ id, nodeId, format, title, status, revision }));
    },
  }),
  "brand.answer": defineAction({
    description: "Save the member's answer to one brand interview question, in their own words. Send the revision from creative_team_brand_read when the question already has an answer.",
    access: "write", input: answerInput, output: json, run: (context: CreativeContext, input) => saveAnswer(context.db(), context.identity, input),
  }),
  "content.source": defineAction({
    description: "Add a content source (omit id), or change one with its id and revision: the member's own posts on one platform (kind own) or a person who shaped their thinking (kind influence), with pasted examples and notes on core ideas, voice and worldview.",
    access: "write", input: sourceInput, output: json, run: (context: CreativeContext, input) => saveSource(context.db(), context.identity, input),
  }),
  "content.profile": defineAction({
    description: "Save the content document's synthesis across every source: core ideas, voice, worldview and replicable patterns. Omitted fields are kept. Send the revision from creative_team_content_read when it is saved already.",
    access: "write", input: profileInput, output: json, run: (context: CreativeContext, input) => saveProfile(context.db(), context.identity, input),
  }),
  "map.branch": defineAction({
    description: "Add to the content map: pillars (no parentId), or children under an existing node (topics under a pillar, ideas under a topic, angles under an idea), each with optional children down to angles. Put what each idea is based on in research.",
    access: "write", input: branchInput, output: json, run: (context: CreativeContext, input) => addBranch(context.db(), context.identity, input),
  }),
  "map.node": defineAction({
    description: "Change one map node's title, notes, research or position, at the revision from creative_team_map_read.",
    access: "write", input: nodeInput, output: json, run: (context: CreativeContext, input) => saveNode(context.db(), context.identity, input),
  }),
  "draft.save": defineAction({
    description: "Save a post draft (omit id to add one) written from a map idea or angle (nodeId), in the member's voice. With id and revision, revise one.",
    access: "write", input: draftInput, output: json, run: (context: CreativeContext, input) => saveDraft(context.db(), context.identity, input),
  }),
});

const writes = ["brand.answer", "content.source", "content.profile", "map.branch", "map.node", "draft.save"] as const;
const reads = ["brand.read", "content.read", "map.read", "drafts.read"] as const;

/** What the assistant sees with every reply: where the member is in the process, never whole documents. */
export async function agentSummary(context: CreativeContext) {
  const state = await readState(context.db());
  const answered = new Set(state.answers.filter((row) => row.answer.trim()).map((row) => row.id));
  const tree = mapTree(state.nodes);
  return {
    brand: {
      answered: answered.size, questions: brandQuestions.length,
      nextQuestions: brandQuestions.filter((question) => !answered.has(question.id)).slice(0, 3).map(({ id, text }) => ({ questionId: id, question: text })),
    },
    content: {
      sources: state.sources.slice(0, 20).map(({ id, kind, name, platform }) => ({ id, kind, name, platform })),
      profileSaved: Boolean(state.profile && [state.profile.coreIdeas, state.profile.voice, state.profile.worldview].some((value) => value.trim())),
    },
    map: { counts: levelCounts(state.nodes), targets: mapTargets, pillars: tree.slice(0, 6).map((pillar) => ({ id: pillar.id, title: pillar.title, topics: pillar.children.slice(0, 10).map((topic) => topic.title) })) },
    drafts: {
      count: state.drafts.length,
      latest: state.drafts.slice(0, 8).map(({ id, title, format, status }) => ({ id, title, format, status })),
    },
  };
}

/** The shared thread service runs inference; the app supplies its records and reviewed writes. */
export function agentRoute(request: Request, operation: string, locals: unknown, internal = false) {
  return respond(async () => {
    if (import.meta.env.OUTFITTER_APP_MODE !== "operational") throw new Response("Read-only demo", { status: 403 });
    const context = creativeContext(request);
    const agent = actionAgent({
      store: new ProposalStore(agentDatabase(), context.identity, { table: "creative_team_proposals", guard: "creative_team_agent_guard" }),
      host: workflowHost<"interactive">(locals as never),
      type: "creative-team.conversation",
      contextType: "creative-team.page",
      focusId,
      label: "Creative team",
      context: async () => context,
      actions: Object.fromEntries(writes.map((name) => [name, { action: actions[name], retry: "inspect" as const, prepare: (input: unknown) => input }])),
      reads: Object.fromEntries(reads.map((name) => [name, actions[name]])),
      instructions,
      routes,
      page: () => agentSummary(context),
    });
    return internal ? agent.provider(request, operation) : agent.browser(request, operation);
  });
}
