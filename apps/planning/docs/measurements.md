# Measurements: recording KPIs from connectors

Goals are measured by metrics (`Goal → measured_by → MetricDefinition`). A
definition says what a KPI means; until now nothing recorded what it actually
was. This adds two records to the organization's graph (Onto, or the old Wiki
until an organization moves) so a connector can record a KPI every week and
anyone, person or agent, can read this week's value, last week's and the change.

Examples: GitHub stars of `ai-outfitter/webapp` this week and growth since last
week; people who reached `/checkout` in PostHog over the last 7 days; a
Prometheus series in Grafana (Cloud or self-hosted) over the week.

## Entities

Defined by Planning in the organization's graph, add-only, like `CodeChange`
(`src/server/measurements.ts`). Existing records and types are never rewritten.

**Measure** (`kind`): how to compute one metric from a connector. A
MetricDefinition is the meaning; a Measure is the executable recipe. One
definition can have several Measures (one per repository, say).

| Property | Example | Meaning |
| --- | --- | --- |
| `connector` | `posthog`, `grafana`, `github` | Provider of an organization connection |
| `operation` | `query.run`, `repositories.read` | Read-only connector operation |
| `resource` | `us.posthog.com/projects/4242`, `acme.grafana.net/orgs/1`, `ai-outfitter/webapp` | What the connection reads; a GitHub repository by `owner/name` |
| `input` | `{"query":"select count(distinct person_id) as visitors from events where properties.$pathname = '/checkout' and timestamp >= toDateTime('{{windowStart}}') and timestamp < toDateTime('{{windowEnd}}')"}` | Operation input as JSON. `{{windowStart}}` and `{{windowEnd}}` become the window's ISO times |
| `value` | `rows.0.visitors`, `frames.0.last.Value`, `stars` | Dot path to the number in the result |
| `unit` | `people`, `stars` | Unit of the value |
| `interval` | `weekly` | `weekly` (Monday 00:00 UTC to the next Monday) or `daily` |

Edge `computes`: Measure → MetricDefinition.

**Measurement** (`event`): one observed value for one window. Its slug is the
measure's slug and window start, so a window is recorded once
(`Measurement:webapp-stars-2026-11-09`).

| Property | Meaning |
| --- | --- |
| `value` | The number. Zero only when the query succeeded and returned zero |
| `unit` | Copied from the Measure |
| `window_start`, `window_end` | Half-open window the value covers (ISO 8601, UTC) |
| `captured_at` | When the connector was read |

Edges `measurement_of`: Measurement → MetricDefinition, and `captured_with`:
Measurement → Measure. The batch that recorded it keeps the evidence (connector,
operation, resource, run).

A level metric such as stars is the count at capture time, shortly after its window ends; a flow metric such
as checkout visitors counts events inside the window. Both are stored the same
way. Growth is never stored: it is the latest value minus the previous one, so a
correction to either week changes it.

A failed read records nothing. Missing, revoked or partial data stays unknown
and is reported on the run, never written as zero.

## Recording

`RecordMeasurements` (MCP mutation, editors) and the `record-measurements`
workflow (manual, and weekly once an editor turns its schedule on) read every
active Measure, find the organization connection for its connector that may
run its operation, run it for the last completed window (last week on the
Monday run, so a flow metric covers a whole week) through `connector.execute`,
read the value at `value`, and stage the Measurements with both edges in one
change batch. Each proposal has confidence 1 (a connector read, not a model
guess), so the batch commits by policy. A window already recorded is skipped.

A Grafana Measure passes the window as the query range, for example
`{"datasourceUid":"prom","query":{"expr":"sum(increase(checkout_total[1w]))","instant":true},"from":"{{windowStart}}","to":"{{windowEnd}}"}`
with value `frames.0.last.Value`.

Planning's manifest declares `connector.posthog.query.run`,
`connector.grafana.query.run` and `connector.github.repositories.read`; a new connector needs one more declared
operation, nothing else.

## Reading

Planning's organization progress (`organizationProgress`) shows each goal KPI
with its latest value instead of "Not connected", and `MetricMeasurements`
returns, per MetricDefinition, the latest and previous Measurements and the
change between them. Agents read both through MCP like any Planning document.

## SemLang

A Measurement is a SemLang `event` concept with occurrence time `captured_at`
and valid time `[window_start, window_end)`; its row grain is
measure × window. A Measure maps to a SemLang measure over that grain
(`value.max()` per window for a level, `value.sum()` across windows for a
flow), and week-over-week growth is a lag over window start. The graph stays the
editable source of truth; a SemLang/Malloy export of Measurements is later work
([Onto and SemLang](../../onto/docs/semlang.md)).

## Not yet

- Audience filters (internal test traffic vs customers) belong in each Measure's
  query for now.
- Timezones other than UTC, monthly windows, backfill of past windows.
- Stripe, Google Analytics and Databricks connectors.
