import { z } from "zod";

import { typeInput, nodeInput, edgeInput, properties } from "@ai-outfitter/app-sdk/graph-contracts";
export { propertyDefinition, typeInput, nodeInput, edgeInput, properties } from "@ai-outfitter/app-sdk/graph-contracts";
export type TypeDefinition = z.infer<typeof typeInput> & {
  id: string;
  revision: number;
  seedVersion: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
};
export type GraphNode = z.infer<typeof nodeInput> & {
  id: string;
  revision: number;
  source: { installationId: string; type: string; id: string } | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
};
export type GraphEdge = z.infer<typeof edgeInput> & {
  id: string;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
};
export type Graph = {
  home?: { organizationId?: string; charterId?: string };
  types: TypeDefinition[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  canEdit: boolean;
};

// Assigned identifiers, never computed from user-editable names or note paths.
const id = (n: number) =>
  `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const core = {
  organization: id(1),
  unit: id(2),
  project: id(3),
  person: id(5),
  agent: id(6),
  technology: id(7),
  // Compatibility for existing callers; software is a Product.
  software: id(15),
  component: id(9),
  goal: id(10),
  metric: id(11),
  document: id(12),
  entity: id(13),
  repository: id(14),
  product: id(15),
  customerSegment: id(16),
  problem: id(17),
  role: id(18),
  roleAssignment: id(19),
  decisionType: id(50),
  authorityDefinition: id(51),
  authorityGrant: id(52),
  belongs: id(21),
  participates: id(22),
  reports: id(23),
  uses: id(24),
  developed: id(25),
  designed: id(26),
  manufactured: id(27),
  supplied: id(28),
  pursues: id(29),
  measured: id(30),
  documents: id(31),
  sourceIn: id(33),
  produces: id(35),
  customerOf: id(36),
  inSegment: id(37),
  experiences: id(38),
  addresses: id(39),
  integrates: id(40),
  assignedTo: id(41),
  assignsRole: id(42),
  scopedTo: id(43),
  hasAuthorityGrant: id(53),
  definedBy: id(54),
  permits: id(55),
  offering: id(56),
  packagesProduct: id(57),
  offeredBy: id(58),
  paysFor: id(59),
  pricedByRole: id(60),
  knowledgeGraph: id(66),
  lensFor: id(67),
  decisionRecord: id(61),
  decisionTypeOf: id(62),
  madeBy: id(63),
  underAssignment: id(64),
  establishes: id(65),

};

export function validateProperties<
  T extends Pick<TypeDefinition, "properties">,
>(type: T, values: z.infer<typeof properties>) {
  const fields = type.properties;
  for (const key of Object.keys(values))
    if (!fields.some((f) => f.name === key))
      throw new Error(`Unknown property: ${key}`);
  for (const field of fields) {
    const value = values[field.name];
    if (value == null) {
      if (field.required) throw new Error(`Required property: ${field.name}`);
    } else if (typeof value !== field.type)
      throw new Error(`Invalid ${field.type} property: ${field.name}`);
  }
}

export const slugify = (title: string) =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "") || "node";

/** `base`, or `base-2`, `base-3`… when taken: slugs are addresses, never identity, so same-named nodes coexist. */
export function freeSlug(base: string, taken: Set<string>) {
  let slug = base;
  for (let n = 2; taken.has(slug); n++)
    slug = `${base.slice(0, 74).replace(/-+$/, "")}-${n}`;
  taken.add(slug);
  return slug;
}
