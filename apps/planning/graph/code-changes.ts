import type { AuthoredGraph } from "@ai-outfitter/app-sdk/graph-authoring";

export const codeChangeType = "e9500000-0000-4000-8000-000000000020";
export const deliversType = "e9500000-0000-4000-8000-000000000021";
export const mergedIntoType = "e9500000-0000-4000-8000-000000000022";

/** Planning's code-change definitions; setup is add-only (src/server/wiki-context.ts). */
export const codeChangeGraph = {
  types: [
    { id: codeChangeType, category: "node", name: "CodeChange", title: "Code changes",
      body: "A pull request merged into a repository, recorded so the work it delivered can be traced to projects. Website is the pull request. It records what merged, not whether the outcome was accepted or deployed.",
      properties: [
        { name: "repository", type: "string", description: "owner/name of the repository it merged into.", required: false },
        { name: "number", type: "number", description: "The pull request number.", required: false },
        { name: "merged_at", type: "string", description: "When it merged (ISO 8601).", required: false },
        { name: "author", type: "string", description: "The GitHub login that opened it.", required: false },
      ] },
    { id: deliversType, category: "edge", name: "delivers", title: "delivers",
      body: "The source CodeChange delivered work for the target Project. The batch that proposed it keeps the evidence and the reason.", properties: [],
      ontology: { version: 2, endpoints: { from: ["planning:CodeChange"], to: ["planning:Project"] } } },
    { id: mergedIntoType, category: "edge", name: "merged_into", title: "merged into",
      body: "The source CodeChange merged into the target Repository.",
      properties: [{ name: "ref", type: "string", description: "The branch it merged into.", required: false }],
      ontology: { version: 2, endpoints: { from: ["planning:CodeChange"], to: ["onto:Repository"] } } },
  ],
  nodes: [],
  edges: [],
} satisfies Pick<AuthoredGraph, "types" | "nodes" | "edges">;
