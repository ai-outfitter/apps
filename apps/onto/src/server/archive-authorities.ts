/** Installation backups retain these tables, but portable archives cannot mint
 * local authority, generation provenance, workflow state or provider receipts.
 * Add new authority/state-machine tables here before exposing archive import. */
export const archiveImportExclusions = [
  "graph_assertion_confirmations",
  "graph_changes",
  "graph_assets",
  "wiki_map_agent_conversations",
  "wiki_map_agent_turns",
  "wiki_map_agent_proposals",
  "wiki_map_proposals",
  "document_definitions",
  "document_heads",
  "document_jobs",
  "document_revisions",
  "document_seals",
  "document_events",
  "document_guards",
  "document_publications",
  "document_runs",
  "onto_review_jobs",
] as const;
