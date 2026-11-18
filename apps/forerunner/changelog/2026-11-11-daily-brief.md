# Standard daily personal Wiki brief

Add the registered `forerunner-daily-brief` workflow, defaulting to 05:00 in its explicitly saved timezone. Settings and named GraphQL documents can read, enable/disable or manually generate it. The collection uses authorized saved Planning reports and current personal board priorities, pins previous-brief context, records unavailable sources, and revision-checks same-owner Wiki writes. Reads never create schedules. Coverage may be incomplete while the capture workflow itself finishes successfully; it must not wait forever for unimplemented adapters.

Focused tests cover schedule scoping, timezone rejection, unknown observations, idempotent capture, archived documents and scheduled dispatch. Local verification enabled the schedule and generated a Wiki document. Provider integrations and automatic replacement of the local homepage mock remain separate work.
