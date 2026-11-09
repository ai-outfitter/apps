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
});

export const documents = publishDocuments(withBatchDocuments(changeDocuments, graphqlSchema, batchGroups), {
  "ChangeBatches": {
    "description": "Find saved change batches and review state; proposals and evidence are opt-in.",
    "collection": true
  },
  "ChangeBatchChanges": {
    "description": "Stage additions durably, then explicitly submit or review a Wiki change batch. Existing review policy applies."
  }
});
