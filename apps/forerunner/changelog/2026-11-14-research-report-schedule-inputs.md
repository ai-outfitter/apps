# Research report schedules save again

Saving a research report schedule was refused in production with "reports is not a run input": the platform accepts only inputs a workflow declares, and the reports were sent under a name the workflow did not declare. The `research` step now declares a `reports` input and the schedule stores the reports under `research.inputs.reports`.

Research reports also run for organizations now: an organization editor saves the reports on the organization's Forerunner and each run saves to the organization's Wiki. They were limited to personal installations.
