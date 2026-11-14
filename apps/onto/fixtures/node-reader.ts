import { z } from "zod";
import { core, type Graph } from "../src/lib/graph";

export const readerId = (n: number) =>
  `8ca861ad-e9c0-4ef4-950e-${String(n).padStart(12, "0")}`;
export const controlPresentation = {
  version: 1,
  entityLabel: "Control definition",
  summaryPath: "description",
  inputLabels: {
    addressed_at_epoch: "First qualifying response",
    triggered_at_epoch: "Issue opened",
    threshold: "Target hours",
    as_of_epoch: "Observation time",
    evidence_complete: "Evidence complete",
    waived: "Approved waiver",
    quarter_start_epoch: "Quarter start",
    quarter_end_epoch: "Quarter end",
    completed_at_epoch: "Interaction completed",
    confirmed_count: "Confirmed interactions",
    interaction_id: "Interaction",
    confirmed: "Confirmed",
  },
  tabs: [
    {
      id: "overview",
      label: "Overview",
      sections: [
        {
          title: "Control at a glance",
          fields: [
            { label: "Target", property: "threshold", suffixProperty: "unit" },
            { label: "Window", property: "window" },
            { label: "Timezone", property: "timezone" },
          ],
        },
        {
          title: "Success criterion",
          fields: [
            { label: "Success criterion", property: "success_criterion" },
          ],
        },
      ],
    },
    {
      id: "measurement",
      label: "Measurement",
      sections: [
        {
          title: "How it is measured",
          fields: [
            {
              label: "Measured value",
              path: "programs.measurement",
              format: "expression",
              description:
                "Calculated from the stored rule. Timestamps are UTC seconds; dividing by 3,600 converts seconds to hours.",
            },
            {
              label: "Deadline",
              path: "programs.deadline",
              format: "expression",
            },
          ],
        },
        {
          title: "How results are determined",
          fields: [
            {
              label: "Decision rules",
              path: "programs.decision",
              format: "decision",
            },
          ],
        },
        {
          title: "Evidence rules",
          fields: [
            { label: "Requirements", path: "evidence_rules" },
            { label: "Reporting", path: "reporting" },
          ],
        },
      ],
    },
    {
      id: "data",
      label: "Data & evidence",
      sections: [
        {
          title: "Sources",
          fields: [
            { label: "Source mappings", path: "sources", format: "table" },
          ],
        },
        {
          title: "Required inputs",
          fields: [
            { label: "Input contract", path: "inputs", format: "table" },
          ],
        },
      ],
    },
  ],
};
const input = (name: string) => ({ input: name }),
  step = (name: string) => ({ step: name }),
  value = (value: unknown) => ({ value });
export const readerBody = {
  description:
    "Qualifying PostHog issues receive a diagnosis, accountable owner and actionable next step within eight elapsed hours.",
  graph_requirements: [
    {
      name: "Accountable owner",
      min_matches: 1,
      path: [
        {
          edge_type_id: readerId(2),
          direction: "outgoing",
          target_type_ids: [core.person],
        },
      ],
    },
  ],
  sources: [
    {
      name: "Issue episodes",
      relation: null,
      key_fields: ["issue_id", "episode"],
      required_fields: ["triggered_at", "addressed_at", "evidence_complete"],
    },
  ],
  inputs: [
    {
      name: "triggered_at_epoch",
      data_type: "UTC timestamp",
      origin: "PostHog",
    },
    {
      name: "addressed_at_epoch",
      data_type: "UTC timestamp",
      origin: "Response evidence",
    },
    {
      name: "evidence_complete",
      data_type: "boolean",
      origin: "Source coverage",
    },
  ],
  programs: {
    measurement: [
      {
        name: "seconds",
        operator: "subtract",
        arguments: [input("addressed_at_epoch"), input("triggered_at_epoch")],
      },
      {
        name: "hours",
        operator: "divide",
        arguments: [step("seconds"), value(3600)],
      },
    ],
    deadline: [
      {
        name: "seconds",
        operator: "multiply",
        arguments: [input("threshold"), value(3600)],
      },
      {
        name: "deadline",
        operator: "add",
        arguments: [input("triggered_at_epoch"), step("seconds")],
      },
    ],
    decision: [
      {
        name: "incomplete",
        operator: "eq",
        arguments: [input("evidence_complete"), value(false)],
      },
      {
        name: "seconds",
        operator: "multiply",
        arguments: [input("threshold"), value(3600)],
      },
      {
        name: "due",
        operator: "add",
        arguments: [input("triggered_at_epoch"), step("seconds")],
      },
      {
        name: "present",
        operator: "is_not_null",
        arguments: [input("addressed_at_epoch")],
      },
      {
        name: "on_time",
        operator: "lte",
        arguments: [input("addressed_at_epoch"), step("due")],
      },
      {
        name: "met",
        operator: "and",
        arguments: [step("present"), step("on_time")],
      },
      {
        name: "late",
        operator: "gte",
        arguments: [input("as_of_epoch"), step("due")],
      },
      {
        name: "result",
        operator: "case",
        arguments: [
          step("incomplete"),
          value("unknown"),
          step("met"),
          value("met"),
          step("late"),
          value("breached"),
          value("pending"),
        ],
      },
    ],
  },
  evidence_rules: [
    "Acknowledgement alone is insufficient.",
    "Repeated exceptions do not reset the episode's deadline.",
  ],
  reporting:
    "Count each issue episode once. Report missing evidence separately from missed deadlines.",
};
const stamp = {
  revision: 1,
  createdBy: "demo",
  updatedBy: "demo",
  createdAt: 1792886400000,
  updatedAt: 1792886400000,
};
export function readerFixture(): Graph {
  return {
    canEdit: false,
    types: [
      {
        id: readerId(1),
        name: "ExampleControl",
        title: "Control definition",
        category: "node",
        body: "A versioned, measurable response rule.",
        properties: [
          ...[
            "state",
            "policy_version",
            "unit",
            "window",
            "timezone",
            "success_criterion",
          ].map((name) => ({
            name,
            type: "string" as const,
            description: name,
            required: false,
          })),
          {
            name: "threshold",
            type: "number",
            description: "Hours",
            required: false,
          },
        ],
        archived: false,
        seedVersion: 1,
        ...stamp,
        jsonSchema: {
          type: "object",
          "x-wiki-presentation": z.json().parse(controlPresentation),
          properties: {
            graph_requirements: {
              type: "array",
              items: { type: "object", "x-wiki-graph-path": true },
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  relation: {
                    type: ["string", "null"],
                    title: "Source relation",
                    "x-wiki-source-binding": true,
                  },
                },
              },
            },
          },
        },
      },
      {
        id: readerId(2),
        name: "example_owner",
        title: "Accountable owner",
        category: "edge",
        body: "The control's accountable person.",
        properties: [],
        ontology: { version: 1, endpoints: { from: [readerId(1)], to: [core.person] } },
        archived: false,
        seedVersion: 1,
        ...stamp,
      },
    ],
    nodes: [
      {
        id: readerId(3),
        typeId: readerId(1),
        title: "PostHog issue response",
        slug: "posthog-response-example",
        summary: readerBody.description,
        body: JSON.stringify(readerBody),
        properties: {
          state: "proposed",
          policy_version: "1",
          threshold: 8,
          unit: "elapsed hours",
          window: "Per qualifying issue episode",
          timezone: "UTC",
          success_criterion:
            "A documented diagnosis, accountable owner and actionable next step.",
        },
        website: null,
        source: null,
        archived: false,
        ...stamp,
      },
      {
        id: readerId(4),
        typeId: core.person,
        title: "Alex Morgan",
        slug: "control-owner-example",
        summary: "Engineering lead for the synthetic control example.",
        body: "Synthetic example person, not a real team member.",
        properties: {},
        website: null,
        source: null,
        archived: false,
        ...stamp,
      },
    ],
    edges: [
      {
        id: readerId(5),
        typeId: readerId(2),
        fromId: readerId(3),
        toId: readerId(4),
        title: "",
        body: "Synthetic owner assignment.",
        properties: {},
        archived: false,
        ...stamp,
      },
    ],
  };
}
