import { graphqlSchema } from "./graphql";
import { withBatchDocuments } from "@ai-outfitter/app-sdk/batch-documents";
import { batchGroups } from "./batch-groups";
// The Wiki's documents: how an agent proposes records for review. Their text lives in
// the SDK (wiki-proposals.ts) so Forerunner runs the same documents; chat agents
// run them with graph_mutate and graph_query; a member commits or rejects the batch
// on the Changes page or over the member's own connection (ReviewBatch); apps and
// delegated writers cannot. scripts/graph-schema.ts writes
// them to graph/documents.json.
import { defineDocuments, publishDocuments } from "@ai-outfitter/app-sdk/app-documents";
import { wikiChangeDocuments } from "@ai-outfitter/app-sdk/graph-contracts";
const changeDocuments = defineDocuments({
  ...wikiChangeDocuments,
  CreativeRecords:{story:"As a member or agent, I want to reuse creative records across apps, so that descriptions stay consistent.",document:`query CreativeRecords($kind:String,$after:String,$limit:Int){creativeRecordViews(kind:$kind,after:$after,limit:$limit)}`},
  StageCreativeRecord:{story:"As an agent, I want to propose a brief, prompt, storyboard, candidate or selection through ordinary graph review, so that shared edits follow existing permissions.",document:`mutation StageCreativeRecord($input:StageCreativeRecordAtAddressInput!){stageCreativeRecordAtAddress(input:$input)}`},
  FreezeCreativeInputs:{story:"As an agent, I want to freeze the exact committed prompt dependencies before generation, so that each output has reproducible inputs.",document:`mutation FreezeCreativeInputs($input:FreezeCreativeInputsAtAddressInput!){freezeCreativeInputsAtAddress(input:$input)}`},
  ReviseBatch: {
    story: "As a member, I want to amend or add undecided proposals in my submitted batch, so that I can link delivery work without approving the proposed product scope.",
    document: `mutation ReviseBatch($input: ReviseBatchInput!) { reviseBatch(input:$input) { id title state counts reviewBy reviewUrl } }`,
  },
  ChangeBatch: {...wikiChangeDocuments.ChangeBatch, hidden:true},
  ChangeBatches: {
    story:"As an agent, I want to search saved change batches and their review state, so that I can resume work without loading every proposal.",
    document:`query ChangeBatches($ids: [ID!], $search: String, $state: [String!], $first: Int = 20, $after: String, $details: Boolean = false, $refs: [String!]) {
      changeBatches(ids:$ids,search:$search,state:$state,first:$first,after:$after) {
        nodes { id title state counts reviewBy reviewUrl instructions @include(if:$details) { code itemKey actor required message } operations(refs:$refs) @include(if:$details) {ref state operation evidence confidence reason decision record recordRevision} }
        pageInfo {hasNextPage endCursor}
      }
    }`,
  },
  Explorations: {
    story:"As a member or agent, I want to list the saved explorations of this Wiki, so that I can open one instead of rebuilding a view.",
    document:`query Explorations { explorations { slug title revision start } }`,
  },
  Exploration: {
    story:"As an agent, I want to see exactly the nodes and relationships a member is looking at in an exploration, so that I can traverse from them and patch the view at its current revision.",
    document:`query Exploration($slug: String!) {
      exploration(slug:$slug) {
        slug title revision state lastChange
        picture { nodes { key type title step url proposedIn } edges { from to label } steps { key count truncated error } truncated }
      }
    }`,
  },
  MutateExploration: {
    story:"As an agent or member, I want to open, close and hide parts of an exploration with one merge patch, so that the page and every agent see the same view change at once.",
    document:`mutation MutateExploration($input: MutateExplorationInput!) {
      mutateExploration(input:$input) {
        slug title revision lastChange
        picture { nodes { key type title step url proposedIn } edges { from to label } steps { key count truncated error } truncated }
      }
    }`,
  },
  Shares: {
    story:"As an editor or agent, I want to list what this graph shows other organizations, so that I can review or change a share.",
    document:`query Shares { shares { slug title revision archived organization graph roots hidden } }`,
  },
  Share: {
    story:"As a member or agent, I want to see exactly what another organization reads through a share, so that nothing is exposed by surprise.",
    document:`query Share($slug: String!) {
      share(slug:$slug) { slug title revision archived organization graph roots hidden view { nodes { address title summary } edges { address } incomplete } }
    }`,
  },
  MutateShare: {
    story:"As an editor, I want to show another organization part of this graph with one merge patch, so that they read current records without a copy.",
    document:`mutation MutateShare($input: MutateShareInput!) {
      mutateShare(input:$input) { slug title revision archived organization graph roots hidden view { nodes { address title summary } edges { address } incomplete } }
    }`,
  },
});

export const documents = publishDocuments(withBatchDocuments(changeDocuments, graphqlSchema, batchGroups), {
 CreativeRecords:{description:"Read shared briefs, fragments, storyboards, snapshots, candidates and selections."},
 StageCreativeRecord:{description:"Stage a typed creative record for graph review; does not generate or approve."},
 FreezeCreativeInputs:{description:"Freeze committed prompt dependencies into a snapshot proposal; does not generate."},
  ReviseBatch: { description: "Amend undecided proposals in a member-review batch without approving or committing them. Only the member's own editor connection may amend." },
  "ChangeBatches": {
    "description": "Find saved change batches and review state; proposals and evidence are opt-in.",
    "collection": true
  },
  "Explorations": {
    "description": "List saved graph explorations: views of this Wiki that members and agents share."
  },
  "Exploration": {
    "description": "Read an exploration's picture (nodes by key, relationships, what each step reached) and its revision."
  },
  "MutateExploration": {
    "description": "Open paths (offerings, products, projects, competitors, issues, repositories, open pullRequests or any edge type), hide nodes or start an exploration with a merge patch; the explore page updates live. Writes no records."
  },
  "Shares": {
    "description": "List what this graph shows other organizations: each share's KnowledgeGraph, roots and hidden nodes."
  },
  "Share": {
    "description": "Preview exactly what another organization reads through a share, as node and edge addresses."
  },
  "MutateShare": {
    "description": "Editors: show another organization part of this graph (a KnowledgeGraph from roots, minus hidden nodes) with a merge patch, or archive the share."
  },
  "ChangeBatchChanges": {
    "description": "Stage additions durably, then explicitly submit or review a Wiki change batch. Existing review policy applies."
  }
});
