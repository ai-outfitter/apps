import { requireEditor } from "@ai-outfitter/app-sdk/server";
import { readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { z } from "zod";
import { githubRepositoryName } from "@ai-outfitter/app-sdk/github-pulls";
import { wikiProjectAnchor } from "../project-readiness";
import type { PlanningContext } from "./intake";

const repositoryURL = z.string().trim().max(300).refine(value => !!githubRepositoryName(value), "Use a GitHub repository URL");
const scope = z.string().trim().max(300).nullable().optional().transform(value => value?.replace(/^\/+|\/+$/g, "") || null);
export const repositoryPatch = z.array(z.strictObject({ url: repositoryURL, path: scope, ref: scope })).max(50)
  .refine(rows => new Set(rows.map(row => githubRepositoryName(row.url))).size === rows.length, "Link each repository once, with its project-specific path and ref")
  .describe("Replace the project's repository links with this list. Links are published immediately by the Planning app.");
export type RepositoryPatch = z.output<typeof repositoryPatch>;
const key = (row: { url: string; path?: string | null; ref?: string | null }) => JSON.stringify([githubRepositoryName(row.url), row.path ?? null, row.ref ?? null]);
type Graph = Awaited<ReturnType<typeof readWikiGraph>>;
type Proposal = { operation: Record<string, unknown>; evidence: []; reason: string };

/** Build an atomic Wiki change: repository nodes are shared; only this project's edges are removed. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconcile existing links and shared repository identities in one pass
export function planRepositoryPatch(graph: Graph, installationId: string, projectId: string, wanted: RepositoryPatch) {
  const type = (name: string) => graph.types.find(row => row.attributes.name === name && !row.attributes.archived)?.ref.id;
  const sourceType = type("source_in"), repositoryType = type("Repository");
  if (!sourceType || !repositoryType) throw new Response("Wiki repository types are unavailable", { status: 409 });
  const anchor = wikiProjectAnchor(graph, installationId, projectId);
  if (!anchor && wanted.length) throw new Response("Wiki Project is unavailable for repository publication", { status: 409 });
  if (!anchor) return [];
  const nodes = graph.nodes.filter(node => !node.attributes.archived && node.attributes.typeId === repositoryType);
  const byId = new Map(nodes.map(node => [node.ref.id, node]));
  const matches = new Map<string, typeof nodes>();
  for (const node of nodes) { const name = githubRepositoryName(node.attributes.website); if (name) matches.set(name, [...(matches.get(name) ?? []), node]); }
  const desired = new Map(wanted.map(row => [key(row), row]));
  const present = new Set<string>();
  const proposals: Proposal[] = [];
  for (const edge of graph.edges) {
    if (edge.attributes.archived || edge.attributes.typeId !== sourceType || edge.attributes.fromId !== anchor) continue;
    const node = byId.get(String(edge.attributes.toId));
    const name = githubRepositoryName(node?.attributes.website); if (!name || !node) continue;
    const properties = edge.attributes.properties as { path?: unknown; ref?: unknown } | undefined;
    const clean = (v: unknown) => typeof v === "string" ? v.trim().replace(/^\/+|\/+$/g, "") || null : null;
    const entry = key({ url: String(node.attributes.website), path: clean(properties?.path), ref: clean(properties?.ref) });
    if (desired.has(entry) && !present.has(entry)) { present.add(entry); continue; }
    proposals.push({ operation: { operation: "update", ref: `$remove${proposals.length}`, type: "graph-edge", id: edge.ref.id, revision: edge.revision, attributes: { archived: true } }, evidence: [], reason: "Remove this project's repository link as requested." });
  }
  const created = new Map<string, string>();
  for (const [entry, row] of desired) {
    if (present.has(entry)) continue;
    const name = githubRepositoryName(row.url)!;
    const existing = matches.get(name) ?? [];
    if (existing.length > 1) throw new Response(`Multiple Wiki repositories match ${name}; resolve the duplicate records first.`, { status: 409 });
    let repoId = existing[0]?.ref.id ?? created.get(name);
    if (!repoId) {
      repoId = crypto.randomUUID(); created.set(name, repoId);
      proposals.push({ operation: { operation: "create", ref: `$repository${proposals.length}`, type: "graph-node", attributes: { id: repoId, typeId: repositoryType, title: name, website: `https://github.com/${name}` } }, evidence: [], reason: "Add the repository named by the project editor." });
    }
    proposals.push({ operation: { operation: "create", ref: `$link${proposals.length}`, type: "graph-edge", attributes: { id: crypto.randomUUID(), typeId: sourceType, fromId: anchor, toId: repoId, properties: { ...(row.path ? { path: row.path } : {}), ...(row.ref ? { ref: row.ref } : {}) } } }, evidence: [], reason: "Link this project's source repository as requested." });
  }
  if (proposals.length > 100) throw new Response("Too many repository changes in one patch", { status: 413 });
  return proposals;
}

/** App-owned publication; conversational agent proposals keep their separate review flow. */
export async function publishRepositories(context: PlanningContext, projectId: string, title: string, wanted: RepositoryPatch) {
  requireEditor(context.identity);
  const host = context.host();
  let graph = await readWikiGraph(host);
  let anchor = wikiProjectAnchor(graph, context.identity.installationId, projectId);
  if (!anchor && wanted.length) {
    const typeId = graph.types.find(row => row.attributes.name === "Project" && !row.attributes.archived)?.ref.id;
    if (!typeId) throw new Response("Wiki Project type is unavailable", { status: 409 });
    try {
      await host.call("entities.create", {
        installationId: graph.wiki.installationId, type: "graph-node",
        attributes: { typeId, title },
        references: [{ installationId: context.identity.installationId, type: "project", id: projectId }],
      });
    } catch (error) {
      // A concurrent request may have created the canonical node. Its source is unique.
      graph = await readWikiGraph(host);
      if (!wikiProjectAnchor(graph, context.identity.installationId, projectId)) throw error;
    }
    graph = await readWikiGraph(host);
    anchor = wikiProjectAnchor(graph, context.identity.installationId, projectId);
    if (!anchor) throw new Response("Wiki Project was not linked. Reload and retry the repository patch.", { status: 409 });
  }
  const proposals = planRepositoryPatch(graph, context.identity.installationId, projectId, wanted);
  if (!proposals.length) return { state: "unchanged", wikiProjectId: anchor ?? null };
  const receipt = await host.call("actions.call", {
    installationId: graph.wiki.installationId, action: "graph.apply",
    input: z.json().parse({ requestKey: crypto.randomUUID(), operations: proposals.map(row => row.operation) }),
  });
  return { state: "published", wikiProjectId: anchor, receipt };
}
