/** One read that tells an agent how to use this graph: its type names, which types each
 * relationship connects, its root, and how to stage a change. It replaces type-by-type
 * discovery, so a writer needs no other read to know what it may write. */
import { asc, eq } from "drizzle-orm";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { readType } from "../lib/type-metadata";
import type { OntologyContract } from "@ai-outfitter/app-sdk/graph-contracts";
import { type Database, rootNode } from "./graph-batches";
import { graphNodes, graphTypes } from "./schema";

/** The first sentence of prose, past any markdown headings. */
const firstSentence = (text: string) => {
  const prose = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).join(" ");
  return (prose.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? prose).slice(0, 200);
};

export const stagingGuide = [
  "Name records by address: a type by its name (Person), a node as Type:slug (Organization:sunny), a relationship as name(From → To).",
  "To add records, run ChangeBatchChanges with one stage item: input {title, purpose, proposals}. Each proposal is {operation, reason}.",
  'A new node: {ref:"$ada", type:"graph-node", operation:"create", attributes:{typeId:"Person", title:"Ada Lovelace", slug:"ada-lovelace"}}.',
  'A new relationship: {ref:"$ada-works-on", type:"graph-edge", operation:"create", attributes:{typeId:"works_on", fromId:"$ada", toId:"Project:sunny"}}. Point at a node created in the same batch by its $ref, at a saved node by its address.',
  "Each relationship type accepts only the node types listed under from and to (any means every node type).",
  "Staging does not itself commit records. Follow the batch's configured review and commit policy and the instructions in its receipt; do not stage the same batch again.",
].join(" ");

export async function ontologyGuide(db: Database, who: AppIdentity) {
  const types = (await db.select().from(graphTypes).where(eq(graphTypes.archived, false)).orderBy(asc(graphTypes.name)))
    .map(readType).map((type) => ({ ...type, ontology: "ontology" in type ? (type.ontology as OntologyContract) : undefined }));
  const names = new Map(types.map((type) => [type.id, type.name]));
  const side = (value: string[] | "any" | undefined) => (value === undefined || value === "any" ? ["any"] : value.map((id) => names.get(id) ?? id));
  const rootId = await rootNode(db, who);
  const [root] = rootId ? await db.select({ typeId: graphNodes.typeId, slug: graphNodes.slug }).from(graphNodes).where(eq(graphNodes.id, rootId)) : [];
  return {
    root: root ? `${names.get(root.typeId)}:${root.slug}` : null,
    nodeTypes: types.filter((type) => type.category === "node").map((type) => ({ name: type.name, description: firstSentence(type.body) })),
    relationshipTypes: types
      .filter((type) => type.category === "edge" && !(type.ontology?.version === 2 && type.ontology.projection))
      .map((type) => ({ name: type.name, description: firstSentence(type.body), from: side(type.ontology?.endpoints?.from), to: side(type.ontology?.endpoints?.to) })),
    staging: `${stagingGuide} ${root ? `New nodes must connect to the owner root, ${names.get(root.typeId)}:${root.slug}, directly or through other nodes. Explicit anchors add another context requirement; empty anchors still require the owner root.` : "This graph has no usable owner root. Staging is allowed, but submission and commit require setup. An editor can run EnsureOwnerRoot, then resolve any reported identity or schema conflicts before revalidating the batch."}`,
  };
}
