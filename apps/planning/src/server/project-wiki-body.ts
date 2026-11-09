/**
 * The project page's body from the Wiki: the goals the project pursues, its use cases
 * and user stories, its draft release and the evidence documents around it, read with
 * one bounded graph.query. The Planning text fields remain a fallback for whatever the
 * Wiki does not hold yet.
 */
import { readWikiGraph, typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { productGraph } from "../lib/graph";
import { projectReleaseRecords, releaseMarkdown } from "./project-releases";
import { projectBodySelection, readProjectSelection } from "./wiki-subgraph";

/** A Wiki page shown on the project page; `path` is its address inside the Wiki (type segment and ID). */
export type WikiBodyRecord = { id: string; title: string; summary: string; path: string };
export type ProjectWikiBody = {
  goals: WikiBodyRecord[];
  useCases: WikiBodyRecord[];
  stories: WikiBodyRecord[];
  /** The latest draft release, as Markdown. */
  release: (WikiBodyRecord & { markdown: string }) | null;
  documents: WikiBodyRecord[];
};

const byTitle = (a: WikiBodyRecord, b: WikiBodyRecord) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** The project's Wiki body, or null when the Wiki cannot be read (the text fields show instead). */
export async function readProjectWikiBody(host: WorkflowHost<"interactive">, installationId: string, projectId: string): Promise<ProjectWikiBody | null> {
  let records: Parameters<typeof productGraph>[0];
  try {
    records = await readProjectSelection(host, installationId, projectId, projectBodySelection);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    if ([400, 404].includes(error.status)) records = await readWikiGraph(host).catch(() => ({ types: [], nodes: [], edges: [] }));
    else return null;
  }
  const graph = productGraph(records);
  const typeName = new Map(graph.types.map((type) => [type.id, type.name]));
  const anchor = graph.nodes.find((node) => !node.archived && typeName.get(node.typeId) === "Project" && node.source?.installationId === installationId && node.source.type === "project" && node.source.id === projectId);
  if (!anchor) return null;
  const linked = (from: string, edge: string) => new Set(graph.edges.filter((e) => !e.archived && e.fromId === from && typeName.get(e.typeId) === edge).map((e) => e.toId));
  const path = (node: { id: string; typeId: string }) => `${typeSegment(typeName.get(node.typeId) ?? "Entity")}/${encodeURIComponent(node.id)}`;
  const record = (node: (typeof graph.nodes)[number]): WikiBodyRecord => ({ id: node.id, title: node.title, summary: node.summary ?? "", path: path(node) });
  const nodes = (ids: Set<string>, type: string) => graph.nodes.filter((node) => ids.has(node.id) && !node.archived && typeName.get(node.typeId) === type).map(record).sort(byTitle);
  const useCases = nodes(linked(anchor.id, "has_use_case"), "UseCase");
  // Stories hang off the project or its use cases.
  const storyIds = new Set([anchor.id, ...useCases.map((useCase) => useCase.id)].flatMap((id) => [...linked(id, "has_story")]));
  const { releases, documents } = projectReleaseRecords(graph, installationId, projectId);
  const latest = [...releases].sort((a, b) => b.revision - a.revision)[0];
  return {
    goals: nodes(linked(anchor.id, "pursues"), "Goal"),
    useCases,
    stories: nodes(storyIds, "UserStory"),
    release: latest ? { id: latest.id, title: latest.title, summary: "", path: path(latest), markdown: releaseMarkdown(latest.body) } : null,
    documents: documents.map((document) => ({ id: document.id, title: document.title, summary: "", path: path(document) })),
  };
}
