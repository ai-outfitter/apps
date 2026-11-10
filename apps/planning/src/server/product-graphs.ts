import { graphDatabase, type GraphDatabase } from "./graph-database";
import { z } from "zod";
import { readProductRoadmap } from "./product-roadmap";
import type { EntityRecord, EntityRef } from "@ai-outfitter/app-sdk/entities";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { wikiPageHref } from "./wiki-links";
import { typeSegment, type readWikiGraph } from "@ai-outfitter/app-sdk/graph-client";
import { readOrganizationProgress } from "./organization-progress";
import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { readScopedOrganizationGraph } from "./scoped-organization-graph";
import {
  exploreOrganizationGraph,
  type OrganizationExploration,
} from "./organization-exploration";
import type { PlanningReadContext } from "./read-context";

export const productGraphsInput = z.strictObject({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(10).default(6),
});
type Graph = Pick<
  Awaited<ReturnType<typeof readWikiGraph>>,
  "nodes" | "edges" | "types"
> & { truncated?: boolean };
type RefRevision = { ref: EntityRef; revision: number };
export type ProductGraphGroup = {
  product: EntityRecord;
  offerings: EntityRecord[];
  projects: EntityRecord[];
  canonicalProjects: {
    nodeId: string;
    ref: EntityRef;
    revision: number;
    title: string;
  }[];
  graph: {
    nodes: ({ id: string; title: string; typeId: string } & RefRevision)[];
    edges: ({
      id: string;
      typeId: string;
      fromId: string;
      toId: string;
      properties: Record<string, unknown>;
    } & RefRevision)[];
    types: ({
      id: string;
      title: string;
      name: string;
      category: string;
    } & RefRevision)[];
  };
  counts: { projects: number; offerings: number; edges: number };
  truncated: { projects: boolean; offerings: boolean; edges: boolean };
};
export type ProductGraphsResponse = Pick<
  OrganizationExploration,
  "organization" | "anchorStatus" | "definition" | "gaps" | "wiki"
> & {
  products: ProductGraphGroup[];
  nextOffset: number | null;
  totalProducts: number;
};
const active = (r: EntityRecord) =>
  !r.attributes.archived && !r.attributes.archivedAt;
const order = (a: EntityRecord, b: EntityRecord) =>
  a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
function bounded<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 500 * 1024)
    throw new Response(
      "Product graphs exceed 500 KiB; request fewer products",
      { status: 413 },
    );
  return JSON.parse(serialized) as T;
}
function includeCanonicalProductProjects(
  edges: EntityRecord[],
  products: Map<string, EntityRecord>,
  projectsById: Map<string, EntityRecord>,
  byId: Map<string, EntityRecord>,
  canonicalById: Map<string, EntityRecord>,
  identity: AppIdentity,
  name: (record: EntityRecord | undefined) => string,
  isOwnership: (edge: EntityRecord) => boolean,
) {
  // Additional canonical projects may join an already-scoped product, but cannot expand product scope.
  for (const edge of edges)
    if (products.has(String(edge.attributes.toId)) && isOwnership(edge)) {
      const project = byId.get(String(edge.attributes.fromId));
      if (
        project &&
        name(project) === "Project" &&
        project.references.some(
          (ref) =>
            ref.installationId === identity.installationId &&
            ref.type === "project" &&
            canonicalById.has(ref.id),
        )
      )
        projectsById.set(project.ref.id, project);
    }
}

function extendProductOwnership(
  edges: EntityRecord[],
  projectsById: Map<string, EntityRecord>,
  products: Map<string, EntityRecord>,
  byId: Map<string, EntityRecord>,
  canonicalById: Map<string, EntityRecord>,
  identity: AppIdentity,
  name: (record: EntityRecord | undefined) => string,
  isOwnership: (edge: EntityRecord) => boolean,
  foreignProvenance: (product: EntityRecord) => boolean,
) {
  // A scoped producing project can establish product scope; mere part_of cannot.
  for (const edge of edges)
    if (
      projectsById.has(String(edge.attributes.fromId)) &&
      name(edge) === "produces" &&
      isOwnership(edge)
    ) {
      const product = byId.get(String(edge.attributes.toId));
      if (product && !foreignProvenance(product))
        products.set(product.ref.id, product);
    }
  includeCanonicalProductProjects(
    edges,
    products,
    projectsById,
    byId,
    canonicalById,
    identity,
    name,
    isOwnership,
  );
}

/** Project/product ownership is explicit and bounded by the already-scoped Organization overview. */
function selectProductGraphs(
  graph: Graph,
  identity: AppIdentity,
  input: z.input<typeof productGraphsInput>,
  canonicalProjects: EntityRecord[] = [],
  allProducts = false,
): ProductGraphsResponse {
  const value = productGraphsInput.parse(input);
  let scoped: EntityRecord[] = [];
  const overview = exploreOrganizationGraph(
    graph,
    identity,
    {},
    canonicalProjects,
    undefined,
    {
      includeReadiness: false,
      sourceTruncated: graph.truncated,
      collectSelected: (nodes) => {
        scoped = nodes;
      },
    },
  );
  const base = {
    organization: overview.organization,
    anchorStatus: overview.anchorStatus,
    definition: overview.definition,
    gaps: overview.gaps,
  };
  if (
    !overview.organization ||
    !overview.definition ||
    overview.gaps.some((g) => g.code === "invalid-overview-definition")
  )
    return { ...base, products: [], nextOffset: null, totalProducts: 0 };
  const typeMap = new Map(graph.types.filter(active).map((t) => [t.ref.id, t]));
  const name = (r: EntityRecord | undefined) =>
    r
      ? String(typeMap.get(String(r.attributes.typeId))?.attributes.name ?? "")
      : "";
  const notRetired = (node: EntityRecord) => {
    try {
      return (
        JSON.parse(String(node.attributes.body ?? "{}"))?.status !== "retired"
      );
    } catch {
      return true;
    }
  };
  const byId = new Map(
    graph.nodes
      .filter((node) => active(node) && notRetired(node))
      .map((n) => [n.ref.id, n]),
  );
  const edges = graph.edges.filter(active).sort(order);
  const selected = new Map(
    scoped.filter((n) => byId.has(n.ref.id)).map((n) => [n.ref.id, n]),
  );
  const canonicalById = new Map(
    canonicalProjects
      .filter(
        (p) =>
          p.ref.installationId === identity.installationId &&
          p.ref.type === "project",
      )
      .map((p) => [p.ref.id, p]),
  );
  const projectsById = new Map(
    [...selected.values()]
      .filter((n) => name(n) === "Project")
      .map((n) => [n.ref.id, n]),
  );
  const products = new Map(
    [...selected.values()]
      .filter((n) => ["Product", "SoftwareProduct"].includes(name(n)))
      .map((n) => [n.ref.id, n]),
  );
  const isOwnership = (e: EntityRecord) =>
    ["produces", "part_of"].includes(name(e)) &&
    ["Product", "SoftwareProduct"].includes(
      name(byId.get(String(e.attributes.toId))),
    );
  const foreignProvenance = (product: EntityRecord) =>
    edges.some(
      (e) =>
        name(e) === "developed_by" &&
        e.attributes.fromId === product.ref.id &&
        name(byId.get(String(e.attributes.toId))) === "Organization" &&
        e.attributes.toId !== overview.organization?.ref.id,
    ) ||
    edges.some(
      (e) =>
        name(e) === "packages_product" &&
        e.attributes.toId === product.ref.id &&
        edges.some(
          (provider) =>
            name(provider) === "offered_by" &&
            provider.attributes.fromId === e.attributes.fromId &&
            name(byId.get(String(provider.attributes.toId))) ===
              "Organization" &&
            provider.attributes.toId !== overview.organization?.ref.id,
        ),
    );
  // Every candidate follows the same ownership rule, including products reached
  // directly by the saved overview rather than the supplemental project pass.
  products.forEach((product, id) => {
    if (foreignProvenance(product)) products.delete(id);
  });
  extendProductOwnership(
    edges,
    projectsById,
    products,
    byId,
    canonicalById,
    identity,
    name,
    isOwnership,
    foreignProvenance,
  );
  const scopedProjects = [...projectsById.values()].sort(order);
  const ownershipEdges = edges.filter(
    (e) =>
      projectsById.has(String(e.attributes.fromId)) &&
      products.has(String(e.attributes.toId)) &&
      isOwnership(e),
  );
  const sortedProducts = [...products.values()].sort(order);
  const groups = sortedProducts
    .slice(
      allProducts ? 0 : value.offset,
      allProducts ? undefined : value.offset + value.limit,
    )
    .map((product): ProductGraphGroup => {
      const associations = ownershipEdges.filter(
        (e) => e.attributes.toId === product.ref.id,
      );
      const associatedIds = new Set(
        associations.map((e) => String(e.attributes.fromId)),
      );
      const allProjects = scopedProjects.filter((n) =>
        associatedIds.has(n.ref.id),
      );
      const projects = allProjects.slice(0, 40),
        shownIds = new Set(projects.map((n) => n.ref.id));
      const allOfferings = [...selected.values()]
        .filter(
          (n) =>
            name(n) === "Offering" &&
            edges.some(
              (e) =>
                name(e) === "packages_product" &&
                e.attributes.fromId === n.ref.id &&
                e.attributes.toId === product.ref.id,
            ),
        )
        .sort(order);
      const primary = associations.filter((e) =>
        shownIds.has(String(e.attributes.fromId)),
      );
      const dependencies = edges.filter(
        (e) =>
          shownIds.has(String(e.attributes.fromId)) &&
          shownIds.has(String(e.attributes.toId)),
      );
      const allEdges = [...primary, ...dependencies],
        shownEdges = allEdges.slice(0, 100);
      const graphNodes = [product, ...projects];
      const usedTypes = new Set(
        [...graphNodes, ...shownEdges].map((n) => String(n.attributes.typeId)),
      );
      return {
        product,
        offerings: allOfferings.slice(0, 30),
        projects,
        canonicalProjects: projects.flatMap((node) => {
          const ref = node.references.find(
            (r) =>
              r.installationId === identity.installationId &&
              r.type === "project" &&
              canonicalById.has(r.id),
          );
          const canonical = ref ? canonicalById.get(ref.id) : undefined;
          return canonical
            ? [
                {
                  nodeId: node.ref.id,
                  ref: canonical.ref,
                  revision: canonical.revision,
                  title: canonical.title,
                },
              ]
            : [];
        }),
        graph: {
          nodes: graphNodes.map((n) => ({
            id: n.ref.id,
            ref: n.ref,
            revision: n.revision,
            title: n.title,
            typeId: String(n.attributes.typeId),
          })),
          edges: shownEdges.map((e) => ({
            id: e.ref.id,
            ref: e.ref,
            revision: e.revision,
            typeId: String(e.attributes.typeId),
            fromId: String(e.attributes.fromId),
            toId: String(e.attributes.toId),
            properties: (e.attributes.properties ?? {}) as Record<
              string,
              unknown
            >,
          })),
          types: [...typeMap.values()]
            .filter((t) => usedTypes.has(t.ref.id))
            .sort(order)
            .map((t) => ({
              id: t.ref.id,
              ref: t.ref,
              revision: t.revision,
              title: t.title,
              name: String(t.attributes.name),
              category: String(t.attributes.category),
            })),
        },
        counts: {
          projects: allProjects.length,
          offerings: allOfferings.length,
          edges: allEdges.length,
        },
        truncated: {
          projects: allProjects.length > 40,
          offerings: allOfferings.length > 30,
          edges: allEdges.length > 100,
        },
      };
    });
  return {
    ...base,
    products: groups,
    totalProducts: sortedProducts.length,
    nextOffset:
      !allProducts && value.offset + value.limit < sortedProducts.length
        ? value.offset + value.limit
        : null,
  };
}
export function productGraphs(
  graph: Graph,
  identity: AppIdentity,
  input: z.input<typeof productGraphsInput>,
  canonicalProjects: EntityRecord[] = [],
): ProductGraphsResponse {
  return bounded(
    selectProductGraphs(graph, identity, input, canonicalProjects),
  );
}
async function readProductSources(
  c: Pick<PlanningReadContext, "identity" | "db" | "host">,
): Promise<{
  graph: Omit<Awaited<ReturnType<typeof readWikiGraph>>, "snapshot"> & { truncated: boolean };
  projects: EntityRecord[];
  context: ReturnType<typeof appDataContext>;
  graphDatabase: GraphDatabase;
}> {
  const host = c.host();
  const context = appDataContext(host);
  const database = graphDatabase(host);
  const [graph, planning, graphDb] = await Promise.all([
    database.then((db) => readScopedOrganizationGraph(db, c.identity)),
    context.apps.installation(c.identity.installationId),
    database,
  ]);
  const projects: EntityRecord[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await planning
      .collection("projects")
      .list({ offset, limit: 100, select: ["id", "name"] });
    projects.push(...page);
    if (page.length < 100) break;
  }
  return { graph, projects, context, graphDatabase: graphDb };
}
export async function readProductGraphs(
  c: Pick<PlanningReadContext, "identity" | "db" | "host">,
  input: z.input<typeof productGraphsInput>,
): Promise<ProductGraphsResponse> {
  const value = productGraphsInput.parse(input);
  const { graph, projects } = await readProductSources(c);
  return bounded({
    ...productGraphs(graph, c.identity, value, projects),
    wiki: graph.wiki,
  });
}
export async function readProductHome(
  c: Pick<PlanningReadContext, "identity" | "db" | "host">,
  url: URL,
) {
  const { graph, projects, context, graphDatabase } = await readProductSources(c);
  const selected = selectProductGraphs(graph, c.identity, {}, projects, true);
  const setup =
    !selected.organization ||
    !selected.definition ||
    selected.gaps.some((g) => g.code === "invalid-overview-definition")
      ? (selected.gaps[0]?.message ??
        "Set up the organization’s Wiki context to show products.")
      : null;
  const types = new Map(
    graph.types.map((t) => [t.ref.id, String(t.attributes.name)]),
  );
  return {
    progress: await readOrganizationProgress(context, c.identity, graph),
    roadmap: selected.organization ? await readProductRoadmap(graphDatabase, selected.organization.ref.id) : null,
    roadmapWikiBase: wikiPageHref(graph.wiki, url, "plans/"),
    wiki: graph.wiki,
    setup,
    incomplete: selected.gaps.some((g) => g.code === "truncated-overview"),
    products: selected.products.map((group) => {
      const canonical = new Map(
        group.canonicalProjects.map((p) => [p.nodeId, p.ref.id]),
      );
      return {
        id: group.product.ref.id,
        title: group.product.title,
        summary: String(group.product.attributes.summary ?? ""),
        href: wikiPageHref(
          graph.wiki,
          url,
          `${typeSegment(types.get(String(group.product.attributes.typeId)) ?? "Product")}/${encodeURIComponent(group.product.ref.id)}`,
        ),
        offerings: group.offerings.map((o) => ({
          id: o.ref.id,
          title: o.title,
          href: wikiPageHref(
            graph.wiki,
            url,
            `offerings/${encodeURIComponent(o.ref.id)}`,
          ),
        })),
        projects: group.projects.map((p) => {
          const canonicalId = canonical.get(p.ref.id);
          return {
            id: p.ref.id,
            title: p.title,
            href:
              canonicalId !== undefined
                ? `/projects/${encodeURIComponent(canonicalId)}`
                : wikiPageHref(
                    graph.wiki,
                    url,
                    `projects/${encodeURIComponent(p.ref.id)}`,
                  ),
          };
        }),
        incomplete: Object.values(group.truncated).some(Boolean),
      };
    }),
  };
}
export type ProductHome = Awaited<ReturnType<typeof readProductHome>>;
