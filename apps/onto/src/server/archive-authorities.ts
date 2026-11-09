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
  "onto_review_jobs",
] as const;
