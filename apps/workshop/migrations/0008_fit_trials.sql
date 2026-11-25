CREATE TABLE workshop_fit_trials (
  projectId TEXT NOT NULL REFERENCES workshop_projects(id) ON DELETE CASCADE,
  trialId TEXT NOT NULL, testedRevision INTEGER NOT NULL,
  data TEXT NOT NULL, recordedAt TEXT NOT NULL, recordedBy TEXT NOT NULL,
  PRIMARY KEY (projectId, trialId)
) STRICT;
--> statement-breakpoint
CREATE INDEX workshop_fit_trials_revision_idx ON workshop_fit_trials(projectId, testedRevision);
