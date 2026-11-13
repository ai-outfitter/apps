# The daily brief is written from cited evidence

The `forerunner-daily-brief` workflow now writes the morning brief with one model answer over saved, authorized records: organization and project reports, the personal Planning overview, open priorities, yesterday's completions, the goals in the saved personal report, the saved role, and open suggestions from the last daily discovery run when it is fresh. Before this the document was an assembled list with no synthesis.

Every statement cites the saved record it rests on, highlights are marked fact or inference, and suggestions are labelled as suggestions with the goal they serve. Missing, stale and never-collected sources are listed under "Not known" by code, not by the model. Source text is treated as data, the payload is bounded to 24,000 bytes, and links or markup in model text are removed.

A rerun with unchanged evidence reuses the saved revision without a model request. A failed or invalid answer writes nothing and reports `status: "failed"` with a reason on the run. Two runs at once produce one revision. Scheduled and manual runs share the path. The job still reads no mail, calendar or analytics, and no schedule or permission changes.

Validation is unit tests with a stand-in model; quality against a real model and account is not yet measured. See [daily brief](../docs/daily-brief.md).
