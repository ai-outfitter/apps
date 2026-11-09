-- Business validity is separate from audit timestamps. Existing records stay unchanged.
ALTER TABLE graph_nodes ADD COLUMN validity text;
--> statement-breakpoint
ALTER TABLE graph_edges ADD COLUMN validity text;
--> statement-breakpoint
-- Keep archived/terminated relationship episodes. Overlap and unordered-pair
-- integrity are validated under the shared full-graph compare-and-swap guard.
DROP INDEX graph_edge_identity_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX graph_edge_active_identity_idx ON graph_edges(typeId,fromId,toId)
WHERE archived=0 AND validity IS NULL;
--> statement-breakpoint
CREATE TABLE graph_assertion_confirmations (
  assertionId text NOT NULL REFERENCES graph_nodes(id),
  assertionRevision integer NOT NULL,
  userId text NOT NULL,
  assertionHash text NOT NULL,
  subjectHash text NOT NULL,
  assertionBody text NOT NULL,
  subjectSnapshot text NOT NULL,
  confirmedAt integer NOT NULL,
  PRIMARY KEY (assertionId,assertionRevision,subjectHash,userId)
) STRICT;
