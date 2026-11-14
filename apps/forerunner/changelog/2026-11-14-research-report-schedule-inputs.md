# Research report schedules save again

Saving a research report schedule was refused in production with "reports is not a run input": the platform accepts only inputs a workflow declares, and the reports were sent under a name the workflow did not declare. The `research` step now declares a `reports` input and the schedule stores the reports under `research.inputs.reports`.
