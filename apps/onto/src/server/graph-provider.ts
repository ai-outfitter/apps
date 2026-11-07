import { graphProviderDescriptor } from "@ai-outfitter/app-sdk/graph-provider";
import { eq } from "drizzle-orm";
import type { Database } from "./graph-batches";
import { graphTypes } from "./schema";

/** Onto is one provider of the generic graph protocol and its own richer ontology contract. */
export async function describeOntoGraph(db: Database) {
  const types = await db.select({ name: graphTypes.name, category: graphTypes.category }).from(graphTypes).where(eq(graphTypes.archived, false));
  return graphProviderDescriptor.parse({
    version: 1,
    contracts: [{ id: "outfitter.graph", version: 1 }, { id: "outfitter.onto", version: 1 }],
    capabilities: ["graphql.read", "ontology", "assertions", "batches"],
    types: types.map(type => ({ name: type.name, kind: type.category === "edge" ? "relationship" : "record" })),
    queryAction: "graph.graphql",
  });
}
