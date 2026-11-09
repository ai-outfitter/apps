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
const legacyDocuments = defineDocuments({
  ...wikiChangeDocuments,
  DocumentRevision: {story:"As an agent, I want to read a generated document revision, so that I can inspect its captured evidence.", document:`query DocumentRevision($input: JSON!) { documentRevision(input:$input) }`},
  DocumentLive: {story:"As an agent, I want to read current document sources, so that I can assess live evidence and completeness.", document:`query DocumentLive($input: JSON!) { documentLive(input:$input) }`},
  DocumentPolicy: {story:"As an agent, I want to evaluate a revision policy, so that I can determine whether an action is allowed.", document:`query DocumentPolicy($input: JSON!) { documentPolicy(input:$input) }`},
  DocumentJob: {story:"As an editor, I want to inspect generation status, so that I can see errors and supersession.", document:`query DocumentJob($input: JSON!) { documentJob(input:$input) }`},
  DefineDocument: {story:"As an owner, I want to define trusted document sources, so that generated revisions use authorized bindings.", document:`mutation DefineDocument($input: JSON!) { defineDocument(input:$input) }`},
  CreateDocument: {story:"As an editor, I want to create a document from a definition, so that I can generate revisions.", document:`mutation CreateDocument($input: JSON!) { createDocument(input:$input) }`},
  GenerateDocument: {story:"As an editor, I want to queue document generation, so that a scheduled worker captures evidence.", document:`mutation GenerateDocument($input: JSON!) { generateDocument(input:$input) }`},
  SealDocument: {story:"As an editor, I want to seal a current revision, so that its captured evidence is recorded without implying approval.", document:`mutation SealDocument($input: JSON!) { sealDocument(input:$input) }`},
  RetryDocument: {story:"As an owner, I want to retry a failed generation, so that a transient source failure can be recovered.", document:`mutation RetryDocument($input: JSON!) { retryDocument(input:$input) }`},
  ChangeBatch: {...wikiChangeDocuments.ChangeBatch, hidden:true},
  ChangeBatches: {
    story:"As an agent, I want to search saved change batches and their review state, so that I can resume work without loading every proposal.",
    document:`query ChangeBatches($ids: [ID!], $search: String, $state: [String!], $first: Int = 20, $after: String, $details: Boolean = false, $refs: [String!]) {
      changeBatches(ids:$ids,search:$search,state:$state,first:$first,after:$after) {
        nodes { id title state counts reviewBy instructions @include(if:$details) { code itemKey actor required message } operations(refs:$refs) @include(if:$details) {ref state operation evidence confidence reason decision recordId recordRevision} }
        pageInfo {hasNextPage endCursor}
      }
    }`,
  },
});

export const documents = publishDocuments(withBatchDocuments(legacyDocuments, graphqlSchema, batchGroups), {
  "DocumentRevision": {description:"Read a generated revision and captured evidence."},
  "DocumentLive": {description:"Read live document sources and completeness."},
  "DocumentPolicy": {description:"Evaluate exact-revision policy for an action."},
  "DocumentJob": {description:"Inspect generation status and failure."},
  "DefineDocument": {description:"Define trusted document sources as an owner or admin."},
  "CreateDocument": {description:"Create a document from a definition."},
  "GenerateDocument": {description:"Queue document generation."},
  "SealDocument": {description:"Seal a revision without granting approval."},
  "RetryDocument": {description:"Retry a failed current generation as an owner or admin."},
  "ChangeBatches": {
    "description": "Find saved change batches and review state; proposals and evidence are opt-in.",
    "collection": true
  },
  "ChangeBatchChanges": {
    "description": "Stage additions durably, then explicitly submit or review a Wiki change batch. Existing review policy applies."
  }
});
