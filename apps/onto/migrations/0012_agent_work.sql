-- Durable advisory review work. Existing reviews and batches remain intact.
ALTER TABLE graph_batches ADD COLUMN reviewJobId text;
--> statement-breakpoint
CREATE TABLE onto_review_jobs (
  id text PRIMARY KEY NOT NULL,
  batchId text NOT NULL REFERENCES graph_batches(id),
  contentDigest text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  leaseId text,
  leaseUntil integer,
  nextAttemptAt integer NOT NULL,
  createdAt integer NOT NULL,
  error text
);
--> statement-breakpoint
CREATE INDEX onto_review_jobs_due ON onto_review_jobs(state, nextAttemptAt, leaseUntil);
