-- The review run reserved when a review job is queued, so a submit receipt can name it
-- (server/batch-review.ts), and Onto's own settings such as steward approval (server/settings.ts).
ALTER TABLE `onto_review_jobs` ADD `runId` text;
CREATE TABLE `onto_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updatedAt` integer NOT NULL,
  `updatedBy` text NOT NULL
) STRICT;
