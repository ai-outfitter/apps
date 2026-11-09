import { appDataContext } from "@ai-outfitter/app-sdk/database";
import {
  exploreKnowledgeGraph,
  isRetired,
  resolveKnowledgeGraph,
} from "@ai-outfitter/app-sdk/knowledge-graph";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import demo from "../../fixtures/project-release-review.json";
import { type Graph, type GraphNode, productGraph } from "../lib/graph";
import { projectBodySelection, readProjectSelection } from "./wiki-subgraph";

export type ProjectReleaseReview = {
  project: { title: string };
  wiki: {
    installationId: string;
    hostname: string | null;
    slug: string;
    writable: boolean;
  } | null;
  releases: Pick<GraphNode, "id" | "title" | "body" | "revision">[];
  documents: Pick<GraphNode, "id" | "title" | "body" | "revision">[];
  /** Screenshots per bundle Document, from the Demonstrations it includes. */
  demonstrations: Record<string, Demonstration[]>;
};

export type Demonstration = { id: string; title: string; media: string[] };

export function demoProjectReleases(projectId: string): ProjectReleaseReview {
  if (projectId !== demo.projectId)
    throw new Response("Project not found", { status: 404 });
  return {
    project: { title: demo.projectTitle },
    wiki: null,
    releases: [{ ...demo.release, body: JSON.stringify(demo.release.body) }],
    documents: [demo.document],
    demonstrations: {},
  };
}

/** Select only records explicitly linked to this installation's canonical project. */
export function projectReleaseRecords(
  graph: Graph,
  installationId: string,
  projectId: string,
) {
  const typeName = (typeId: string) =>
    graph.types.find((type) => !type.archived && type.id === typeId)?.name;
  const anchors = graph.nodes.filter(
    (node) =>
      !node.archived &&
      !isRetired(node) &&
      typeName(node.typeId) === "Project" &&
      node.source?.installationId === installationId &&
      node.source.type === "project" &&
      node.source.id === projectId,
  );
  if (anchors.length > 1)
    throw new Response(
      "Multiple Wiki projects reference this project. Resolve the duplicate references before reviewing releases.",
      { status: 409 },
    );
  if (!anchors.length) return { releases: [], documents: [], demonstrations: {} };
  const definition = resolveKnowledgeGraph(graph, {
    root_type: "Project",
    root_types: ["Project"],
    max_depth: 2,
    max_nodes: 200,
    stop_at_types: ["Document"],
    relationships: [
      {
        type: "part_of",
        direction: "incoming",
        from_type: "Release",
        to_type: "Project",
      },
      {
        type: "documents",
        direction: "incoming",
        from_type: "Document",
        to_type: "Project",
      },
      {
        type: "documents",
        direction: "incoming",
        from_type: "Document",
        to_type: "Release",
      },
    ],
  });
  const selection = exploreKnowledgeGraph(graph, anchors[0], definition);
  if (selection.truncated)
    throw new Response("Release review exceeds its supported size.", {
      status: 413,
    });
  const sorted = [...selection.nodes].sort(
    (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
  const documents = sorted.filter((node) => typeName(node.typeId) === "Document");
  return {
    releases: sorted.filter((node) => typeName(node.typeId) === "Release"),
    documents,
    demonstrations: Object.fromEntries(
      documents.map((document) => [document.id, bundleDemonstrations(graph, document.id, typeName)]),
    ),
  };
}

/** The Demonstrations an evidence bundle includes (scripts/evidence-bundle.mjs), with their https screenshots. */
function bundleDemonstrations(
  graph: Graph,
  bundleId: string,
  typeName: (typeId: string) => string | undefined,
): Demonstration[] {
  const ids = new Set(
    graph.edges
      .filter((edge) => !edge.archived && edge.fromId === bundleId && typeName(edge.typeId) === "includes_record")
      .map((edge) => edge.toId),
  );
  return graph.nodes
    .filter((node) => ids.has(node.id) && !node.archived && !isRetired(node) && typeName(node.typeId) === "Demonstration")
    .map((node) => ({
      id: node.id,
      title: node.title,
      media: items(releaseBody(node.body).media).filter(
        (url): url is string => typeof url === "string" && url.startsWith("https://"),
      ),
    }))
    .filter((demonstration) => demonstration.media.length)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export async function readProjectReleases(
  host: WorkflowHost<"interactive">,
  installationId: string,
  projectId: string,
) {
  const db = await appDataContext(host).apps.installation(installationId);
  // Authenticate the canonical project before reading any Wiki context.
  const project = await db.collection("projects").get(projectId);
  // Only the project's releases and their evidence, not the whole Wiki; the whole graph from a Wiki without graph.query.
  const records = await readProjectSelection(host, installationId, projectId, projectBodySelection).catch((error) => {
    if (error instanceof Response && [400, 404].includes(error.status)) return readWikiGraph(host);
    throw error;
  });
  return {
    project,
    wiki: records.wiki,
    ...projectReleaseRecords(productGraph(records), installationId, projectId),
  };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const items = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export function releaseBody(body: string) {
  try {
    return object(JSON.parse(body));
  } catch {
    return {};
  }
}

/** Customer-facing Release fields; never present a draft as delivery evidence. */
export function releaseMarkdown(body: string) {
  const value = releaseBody(body),
    lines: string[] = [];
  const section = (label: string, content: string) => {
    if (content) lines.push(`## ${label}`, "", content, "");
  };
  if (text(value.headline)) lines.push(`## ${text(value.headline)}`, "");
  if (text(value.subheadline)) lines.push(text(value.subheadline), "");
  for (const [key, label] of [
    ["customer", "Who it is for"],
    ["problem", "Problem"],
    ["solution", "Solution"],
    ["announceTarget", "Announcement target"],
    ["gettingStarted", "Getting started"],
    ["successMeasure", "Success measure"],
  ])
    section(label, text(value[key]));
  for (const [key, label] of [
    ["inScope", "In scope"],
    ["outOfScope", "Out of scope"],
  ]) {
    section(
      label,
      items(value[key])
        .map(object)
        .filter((item) => text(item.statement))
        .map(
          (item) =>
            `- ${text(item.statement)}${text(item.reason) ? ` ${text(item.reason)}` : ""}`,
        )
        .join("\n"),
    );
  }
  for (const [key, label] of [
    ["leaderQuote", "Team quote"],
    ["customerQuote", "Customer quote"],
  ]) {
    const quote = object(value[key]);
    section(
      label,
      text(quote.text)
        ? `${text(quote.text)}\n\n${text(quote.speakerRole) || text(quote.persona)}${quote.hypothetical === true ? " (hypothetical)" : ""}`
        : "",
    );
  }
  const faq = items(value.faq).map(object);
  section(
    "FAQ",
    faq
      .filter((item) => text(item.question))
      .map((item) => `### ${text(item.question)}\n\n${text(item.answer)}`)
      .join("\n\n"),
  );
  section(
    "Open questions",
    items(value.openQuestions)
      .filter((item) => typeof item === "string")
      .map((item) => `- ${item}`)
      .join("\n"),
  );
  return (
    lines.join("\n") ||
    "Release details are unavailable. Review the source record."
  );
}
