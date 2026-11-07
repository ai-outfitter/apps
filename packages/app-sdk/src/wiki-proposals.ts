/**
 * How any agent proposes Wiki records from connected sources (Gmail, Calendar,
 * Slack, GitHub). Forerunner's discovery prompt and the MCP server instructions
 * that chat clients read both use these rules, so the same email yields the same
 * proposals on either path (docs/architecture/evidence.md, docs/agent-mcp.md).
 */
export const wikiProposalRules = [
  "Reuse an existing node of the same type before creating another; matching an existing node is itself a proposal for review.",
  "Use only the entity and relationship types the Wiki's ontology defines, with the source and target types each relationship allows.",
  "A mailbox address is not a Person name: never create a Person from an email address alone, and never connect two people because one is an alias of the other.",
  "Calendar events, meetings and recurring series are evidence, not entities. Calendar-only evidence may introduce people named in the title or participants; other new entities need another source.",
  "Skip newsletter authors, public speakers, marketing senders and audiences unless the sources show a direct relationship. A notification, registration or newsletter is not an interaction, friendship, customer relationship or paid usage.",
  "Do not invent roles, ownership, preferences, payments or completed transactions. Say whether something was scheduled, inferred or observed.",
  "Confidence is your own estimate, from 0 to 1, that the proposal is true and supported by its evidence: 0.95 or more only when a source states it directly. Give each proposal a short reason.",
] as const;

/**
 * How an agent that cites sources itself writes each evidence item. Forerunner
 * cites the records it was given by reference and builds these items in code.
 */
export const wikiEvidenceRule =
  "Cite every proposal with evidence items {provider, recordId, quote, observedAt, uri, version}: the provider namespace (gmail, google-calendar, slack, github), the source's stable record ID, a short verbatim quote, when it was observed, an https link, and a version for sources that can change.";

/** The rules as a Markdown list. */
export const wikiProposalRulesText = wikiProposalRules.map((rule) => `- ${rule}`).join("\n");

/**
 * The Wiki's change-batch documents. The Wiki publishes them (its documents.ts),
 * chat clients run them with graph_mutate and graph_query, and Forerunner runs
 * the same text over the Wiki's graph.mutate action, so every writer stages alike.
 */
export const wikiChangeDocuments = {
  StageChanges: {
    story: "As an agent, I want to stage proposed Wiki records with their evidence in a batch, so that a member reviews them before anything is committed.",
    document: `mutation StageChanges($input: StageChangesInput!) {
      stageChanges(input: $input) { id title state counts }
    }`,
  },
  RemoveStagedChanges: {
    story: "As an agent, I want to take back proposals I staged by mistake, so that the member reviews only what I still propose.",
    document: `mutation RemoveStagedChanges($input: RemoveStagedChangesInput!) {
      removeStagedChanges(input: $input) { id state counts }
    }`,
  },
  SubmitBatch: {
    story: "As an agent, I want to submit my staged batch for review, so that it appears on the Wiki's Changes page for a member to commit or reject.",
    document: `mutation SubmitBatch($input: SubmitBatchInput!) {
      submitBatch(input: $input) { id state reviewBy counts operations { ref state } }
    }`,
  },
  ChangeBatch: {
    story: "As an agent, I want to inspect a change batch with its proposed records and evidence, so that I can explain suggestions, check decisions and help a member correct inaccurate projects.",
    document: `query ChangeBatch($id: ID!, $refs: [String!]) {
      changeBatch(id: $id) {
        id title purpose source state policy summary reviewBy createdAt updatedAt expiresAt counts
        operations(refs: $refs) { ref state operation evidence confidence reason decision recordId recordRevision }
      }
    }`,
  },
};
