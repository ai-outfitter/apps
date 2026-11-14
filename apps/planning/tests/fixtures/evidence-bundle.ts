import { evidenceBundleOperations, type EvidenceProposal } from "@ai-outfitter/app-sdk/evidence-bundle";
import type { Graph, GraphEdge, GraphNode, TypeDefinition } from "../../src/lib/graph";
import { releaseId } from "./project-releases";

const stamp = { revision: 1, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null, archived: false };
export const projectNodeId = releaseId(1);
export const productId = releaseId(2);
export const documentId = "07191fef-42bc-54d9-8bc7-01bd1d8be3a2";
export const shot = (n: number) => `https://software-foundry.org.example/files/main/evidence/ios-run/${n}.png`;
export const standardTypes = ["Project", "Product", "Document", "Demonstration", "documents", "includes_record"];
export const steps = [
  { title: "Office collection", url: shot(1) },
  { title: "Unconfirmed plant identity", url: shot(2) },
  { title: "Saved to Office", url: shot(3) },
  { title: "Confirmed after app relaunch", url: shot(4) },
];

/** A Wiki graph holding the Planning project's Onto Project and a Product. */
export function baseGraph(typeNames: string[]): Graph {
  const types: TypeDefinition[] = typeNames.map((name, i) => ({
    ...stamp,
    id: releaseId(100 + i),
    name,
    title: name,
    category: /^[A-Z]/.test(name) ? "node" : "edge",
    body: "Fixture definition",
    properties: [],
    seedVersion: null,
  }));
  const typeId = (name: string) => types.find((type) => type.name === name)?.id ?? "";
  const node = (id: string, type: string, title: string): GraphNode => ({
    ...stamp, id, typeId: typeId(type), title, summary: "", body: "", website: null, properties: {}, source: null,
  });
  const project = node(projectNodeId, "Project", "Garden sensor");
  project.source = { installationId: "planning", type: "project", id: releaseId(9) };
  return { canEdit: false, types, nodes: [project, node(productId, "Product", "Plant planner")], edges: [] };
}

/** What approving the batch does to the Wiki graph. */
export function approve(graph: Graph, ops: EvidenceProposal[]) {
  for (const { type, attributes } of ops) {
    const a = attributes as Record<string, unknown>;
    if (type === "graph-type") graph.types.push({ ...stamp, seedVersion: null, ...a } as TypeDefinition);
    if (type === "graph-node") graph.nodes.push({ ...stamp, summary: "", body: "", website: null, properties: {}, source: null, ...a } as GraphNode);
    if (type === "graph-edge") graph.edges.push({ ...stamp, title: "", body: "", properties: {}, ...a } as GraphEdge);
  }
}

export async function bundle(graph: Graph, overrides: { projectNodeId?: string } = {}) {
  return evidenceBundleOperations({
    types: graph.types.map(({ id, name, category }) => ({ id, name, category })),
    document: {
      id: documentId,
      slug: "ios-confirmation-evidence",
      title: "iOS plant confirmation — happy-path test evidence",
      body: "# iOS plant confirmation happy path\n\n**Result:** 1 XCUITest passed; 0 failed; 0 skipped.\n\n## Coverage limits\n\nSimulator and fixture backend only. Checkout remains mocked.",
    },
    projectNodeId: overrides.projectNodeId ?? projectNodeId,
    subject: { id: productId, revision: 1 },
    environment: "iPhone 17 Pro simulator, iOS 26.5; local fixture API",
    capturedAt: "2026-11-14T05:26:59Z",
    limitations: ["Simulator and fixture backend; not a physical iPhone."],
    steps,
  });
}

