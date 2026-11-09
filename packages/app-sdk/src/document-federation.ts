import { getNamedType, isObjectType, type GraphQLSchema, type OperationDefinitionNode, Kind } from "graphql";

/** A standard connection document can be read once across its caller's authorized installations. */
export type DocumentFederation = { collection: string; cursorVariable: "after" | "cursor"; organizationFilter?: string; provenance?: "organizationSlug"; markdown?: { title: string; slug?: string; body?: string } };

/** Infer only the ordinary first/after connection contract; compound and lifecycle queries stay scoped. */
export function documentFederation(schema: GraphQLSchema, operation: OperationDefinitionNode): DocumentFederation | undefined {
  if (operation.operation !== "query" || operation.selectionSet.selections.length !== 1) return;
  const field = operation.selectionSet.selections[0];
  if (field.kind !== Kind.FIELD || field.directives?.length) return;
  const args = new Map(field.arguments?.map(arg => [arg.name.value, arg.value]));
  const first = args.get("first"), after = args.get("after");
  if (first?.kind !== Kind.VARIABLE || first.name.value !== "first" || after?.kind !== Kind.VARIABLE || after.name.value !== "after") return;
  const root = schema.getQueryType()?.getFields()[field.name.value];
  const connection = root && getNamedType(root.type);
  if (!connection || !isObjectType(connection)) return;
  const selected = field.selectionSet?.selections.filter(selection => selection.kind === Kind.FIELD);
  const nodes = selected?.find(selection => selection.name.value === "nodes");
  const info = selected?.find(selection => selection.name.value === "pageInfo");
  if (!connection.getFields().nodes || !connection.getFields().pageInfo || !nodes || nodes.alias || nodes.directives?.length || !info || info.alias || info.directives?.length) return;
  const pageFields = info.selectionSet?.selections.flatMap(selection => selection.kind === Kind.FIELD && !selection.alias && !selection.directives?.length ? [selection.name.value] : []);
  if (!pageFields?.includes("endCursor") || !pageFields.includes("hasNextPage")) return;
  return { collection: field.alias?.value ?? field.name.value, cursorVariable: "after" };
}
