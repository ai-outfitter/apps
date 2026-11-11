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

/** An Onto Project node slug; `Project:<slug>` addresses are accepted. */
export const projectNodeSlug = z.string().trim().max(88).transform(value => value.replace(/^Project:/, ""))
  .pipe(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a Project node slug such as reduce-databricks-costs").max(80))
  .describe("Link this project to its Onto Project node by slug (reduce-databricks-costs or Project:reduce-databricks-costs). An unlinked Project node with this slug is linked; when none exists one is created with this slug and the project's name. No repository is needed. A project linked to a different node is refused.");

type Linked = { state: "unchanged" | "linked" | "created"; wikiProjectId: string; slug: string | null };
const nodeSlug = (graph: Graph, id: string) => {
  const slug = graph.nodes.find(node => node.ref.id === id)?.attributes.slug;
  return typeof slug === "string" ? slug : null;
};

/** Make sure exactly one Onto Project node documents this Planning project, without touching repositories. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: link an existing node or create one, tolerating a concurrent link
export async function linkProjectNode(context: PlanningContext, projectId: string, title: string, slug?: string): Promise<Linked> {
  requireEditor(context.identity);
  const host = context.host();
  const installationId = context.identity.installationId;
  const reference = { installationId, type: "project", id: projectId };
  let graph = await readWikiGraph(host);
  const linked = () => {
    const anchor = wikiProjectAnchor(graph, installationId, projectId);
    return anchor ? { wikiProjectId: anchor, slug: nodeSlug(graph, anchor) } : null;
  };
  const current = linked();
  if (current) {
    if (slug && current.slug !== slug) throw new Response(`This project is already linked to Project:${current.slug ?? current.wikiProjectId}.`, { status: 409 });
    return { state: "unchanged", ...current };
  }
  const typeId = graph.types.find(row => row.attributes.name === "Project" && !row.attributes.archived)?.ref.id;
  if (!typeId) throw new Response("Onto Project type is unavailable", { status: 409 });
  const existing = slug ? graph.nodes.find(node => node.attributes.typeId === typeId && node.attributes.slug === slug && !node.attributes.archived) : undefined;
  if (existing?.references.length) throw new Response(`Project:${slug} already documents another app record.`, { status: 409 });
  try {
    if (existing)
      await host.call("entities.update", { installationId: graph.wiki.installationId, type: "graph-node", id: existing.ref.id, revision: existing.revision, attributes: { title: existing.title }, references: [reference] });
    else
      await host.call("entities.create", { installationId: graph.wiki.installationId, type: "graph-node", attributes: { typeId, title, ...(slug ? { slug } : {}) }, references: [reference] });
  } catch (error) {
    // A concurrent request may have linked the canonical node. Its source is unique.
    graph = await readWikiGraph(host);
    if (!linked()) throw error;
  }
  graph = await readWikiGraph(host);
  const saved = linked();
  if (!saved) throw new Response("Onto Project was not linked. Reload and retry.", { status: 409 });
  if (slug && saved.slug !== slug) throw new Response(`This project is already linked to Project:${saved.slug ?? saved.wikiProjectId}.`, { status: 409 });
  return { state: existing ? "linked" : "created", ...saved };
}

/** App-owned publication; conversational agent proposals keep their separate review flow. */
export async function publishRepositories(context: PlanningContext, projectId: string, title: string, wanted: RepositoryPatch) {
  requireEditor(context.identity);
  const host = context.host();
  if (wanted.length) await linkProjectNode(context, projectId, title);
  const graph = await readWikiGraph(host);
  const anchor = wikiProjectAnchor(graph, context.identity.installationId, projectId);
  const proposals = planRepositoryPatch(graph, context.identity.installationId, projectId, wanted);
  if (!proposals.length) return { state: "unchanged", wikiProjectId: anchor ?? null };
  const receipt = await host.call("actions.call", {
    installationId: graph.wiki.installationId, action: "graph.apply",
    input: z.json().parse({ requestKey: crypto.randomUUID(), operations: proposals.map(row => row.operation) }),
  });
  return { state: "published", wikiProjectId: anchor, receipt };
}
