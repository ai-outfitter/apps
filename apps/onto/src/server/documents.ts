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
import { wikiChangeDocuments } from "@ai-outfitter/onto/contracts";
const changeDocuments = defineDocuments({
  ...wikiChangeDocuments,
  ChangeBatch: {...wikiChangeDocuments.ChangeBatch, hidden:true},
  ChangeBatches: {
    story:"As an agent, I want to search saved change batches and their review state, so that I can resume work without loading every proposal.",
    document:`query ChangeBatches($ids: [ID!], $search: String, $state: [String!], $first: Int = 20, $after: String, $details: Boolean = false, $refs: [String!]) {
      changeBatches(ids:$ids,search:$search,state:$state,first:$first,after:$after) {
        nodes { id title state counts reviewBy instructions @include(if:$details) { code itemKey actor required message } operations(refs:$refs) @include(if:$details) {ref state operation evidence confidence reason decision record recordRevision} }
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
});

export const documents = publishDocuments(withBatchDocuments(changeDocuments, graphqlSchema, batchGroups), {
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
  "ChangeBatchChanges": {
    "description": "Stage additions durably, then explicitly submit or review a Wiki change batch. Existing review policy applies."
  }
});
