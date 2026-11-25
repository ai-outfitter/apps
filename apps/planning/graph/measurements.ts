import type { AuthoredGraph } from "@ai-outfitter/app-sdk/graph-authoring";

export const measureType = "e9500000-0000-4000-8000-000000000030";
export const measurementType = "e9500000-0000-4000-8000-000000000031";
export const computesType = "e9500000-0000-4000-8000-000000000032";
export const measurementOfType = "e9500000-0000-4000-8000-000000000033";
export const capturedWithType = "e9500000-0000-4000-8000-000000000034";

const text = (name: string, description: string) => ({ name, type: "string" as const, description, required: false });
/** Planning's measurement definitions; setup is add-only (src/server/wiki-context.ts). */
export const measurementGraph = {
  types: [
    { id: measureType, category: "node", name: "Measure", title: "Measures",
      body: "## Measures\n\nHow to compute one metric from a connector: the connector, its read-only operation, the resource it reads, the operation input (JSON, where `{{windowStart}}` and `{{windowEnd}}` become the window's ISO times), the dot path to the number in the result, its unit and interval. Link the MetricDefinition it computes with `computes`.\n\n## For agents\n\nPlanning's RecordMeasurements runs every Measure and records a Measurement per window. A Measure is a recipe, not an observed value.",
      properties: [
        text("connector", "Connector provider, for example posthog, grafana or github."),
        text("operation", "Read-only connector operation, for example query.run or repositories.read."),
        text("resource", "What the connection reads: a PostHog project (us.posthog.com/projects/4242), a Grafana organization (acme.grafana.net/orgs/1) or a GitHub repository (owner/name)."),
        text("input", "Operation input as JSON; {{windowStart}} and {{windowEnd}} are replaced with the window's ISO times."),
        text("value", "Dot path to the number in the result, for example rows.0.visitors or stars."),
        text("unit", "Unit of the value, for example people or stars."),
        text("interval", "weekly (Monday 00:00 UTC to the next Monday) or daily."),
      ],
      ontology: { version: 2, stereotype: "kind" } },
    { id: measurementType, category: "node", name: "Measurement", title: "Measurements",
      body: "## Measurements\n\nOne observed value of a metric for one half-open window, read from a connector. Zero means the read succeeded and returned zero; a failed read records nothing. Growth is not stored: compare with the previous window's Measurement.\n\n## For agents\n\nRead the MetricDefinition (`measurement_of`) for meaning and the Measure (`captured_with`) for how it was computed. The batch that recorded it keeps the evidence.",
      properties: [
        { name: "value", type: "number", description: "The observed value.", required: true },
        text("unit", "Unit of the value."),
        text("window_start", "Start of the window the value covers (ISO 8601, UTC, inclusive)."),
        text("window_end", "End of the window (ISO 8601, UTC, exclusive)."),
        text("captured_at", "When the connector was read (ISO 8601)."),
      ],
      ontology: { version: 2, stereotype: "event" } },
    { id: computesType, category: "edge", name: "computes", title: "computes",
      body: "The source Measure computes the target MetricDefinition from a connector.", properties: [],
      ontology: { version: 2, endpoints: { from: ["planning:Measure"], to: ["planning:MetricDefinition"] } } },
    { id: measurementOfType, category: "edge", name: "measurement_of", title: "measurement of",
      body: "The source Measurement is an observed value of the target MetricDefinition.", properties: [],
      ontology: { version: 2, endpoints: { from: ["planning:Measurement"], to: ["planning:MetricDefinition"] } } },
    { id: capturedWithType, category: "edge", name: "captured_with", title: "captured with",
      body: "The source Measurement was computed by the target Measure.", properties: [],
      ontology: { version: 2, endpoints: { from: ["planning:Measurement"], to: ["planning:Measure"] } } },
  ],
  nodes: [],
  edges: [],
} satisfies Pick<AuthoredGraph, "types" | "nodes" | "edges">;
