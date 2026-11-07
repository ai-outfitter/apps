import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { documentRunner } from "@ai-outfitter/app-sdk/app-graphql";
import { graphql } from "../../graph/graphql";
import { batchGroups } from "./batch-groups";
import type { CreativeContext } from "./context";
import { graphqlSchema } from "./graphql";

// The writes the pages run, each with the user story that keeps it. scripts/graph-schema.ts
// writes them to graph/documents.json, which the platform lists (graph_documents) and runs by
// name (graph_mutate); the page routes run the same documents with runDocument.
const pageDocuments = defineDocuments({
  BrandQuestions: {
    story: "As a creator or an agent interviewing them, I want the brand interview's questions in order, so that answers land on the right question.",
    document: graphql("query BrandQuestions { brandQuestions { id section sectionTitle text hint } }"),
  },
  SaveBrandAnswer: {
    story: "As a creator, I want to save my answer to a brand interview question, so that my brand document grows as I think.",
    document: graphql("mutation SaveBrandAnswer($input: SaveBrandAnswerInput!) { saveBrandAnswer(input: $input) { id answer revision } }"),
  },
  SaveSource: {
    story: "As a creator, I want to add my best posts or the people who shaped me to my content document, so that ideas and drafts start from what makes me unique.",
    document: graphql("mutation SaveSource($input: SaveSourceInput!) { saveSource(input: $input) { id kind name revision } }"),
  },
  DeleteSource: {
    story: "As a creator, I want to remove a source that no longer represents me, so that the content document stays focused.",
    document: graphql("mutation DeleteSource($input: DeleteSourceInput!) { deleteSource(input: $input) { id deleted } }"),
  },
  SaveContentProfile: {
    story: "As a creator, I want to save the core ideas, voice and worldview my sources share, so that every draft carries them.",
    document: graphql("mutation SaveContentProfile($input: SaveContentProfileInput!) { saveContentProfile(input: $input) { id revision } }"),
  },
  AddMapBranch: {
    story: "As a creator, I want to add pillars, topics, ideas and angles to my content map, so that I have months of ideas through my own lens.",
    document: graphql("mutation AddMapBranch($input: AddMapBranchInput!) { addMapBranch(input: $input) { added ids } }"),
  },
  SaveMapNode: {
    story: "As a creator, I want to rename or annotate a map node, so that the map says what I mean.",
    document: graphql("mutation SaveMapNode($input: SaveMapNodeInput!) { saveMapNode(input: $input) { id title revision } }"),
  },
  DeleteMapNode: {
    story: "As a creator, I want to remove a branch of my content map I no longer want to post about, so that the map stays mine.",
    document: graphql("mutation DeleteMapNode($input: DeleteMapNodeInput!) { deleteMapNode(input: $input) { id deleted } }"),
  },
  SaveDraft: {
    story: "As a creator, I want to save and edit drafts written from my content map, so that I review and rewrite instead of starting from scratch.",
    document: graphql("mutation SaveDraft($input: SaveDraftInput!) { saveDraft(input: $input) { id status revision } }"),
  },
  DeleteDraft: {
    story: "As a creator, I want to remove a draft I won't post, so that my drafts list stays short.",
    document: graphql("mutation DeleteDraft($input: DeleteDraftInput!) { deleteDraft(input: $input) { id deleted } }"),
  },
});

// What outside agents (the Outfitter connector) can read and change. Writes go
// through the batch documents, so each change returns a receipt.
export const documents = publishDocuments(withBatchDocuments(pageDocuments, graphqlSchema, batchGroups), {
  BrandQuestions: { description: "Read the brand interview: every question, its section and hint, in order." },
  BrandAnswers: { description: "Read the member's saved brand interview answers (the brand document)." },
  Sources: { description: "Read content sources: the member's own posts per platform or the people who shaped their thinking, with pasted examples and notes." },
  ContentProfiles: { description: "Read the content document's synthesis: core ideas, voice, worldview and replicable patterns." },
  MapNodes: { description: "Read the content map: pillars, topics, ideas and angles, filterable by level or parent." },
  Drafts: { description: "Read post drafts written from the content map, with format and status." },
  BrandChanges: { description: "Save brand interview answers in the member's own words. Never write an answer the member did not give." },
  ContentChanges: { description: "Add, change or delete content sources and save the voice, ideas and worldview synthesis." },
  MapChanges: { description: "Add content map branches (pillars, topics, ideas, angles), change a node, or delete a branch." },
  DraftChanges: { description: "Save, revise or delete post drafts. Drafts are never posted anywhere." },
});

/** Run one of these documents in process, as a page route does (documentRunner). */
export const runDocument = documentRunner<CreativeContext>(() => graphqlSchema);
