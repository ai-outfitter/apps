import { documentSchema } from "@ai-outfitter/app-sdk/agent-schema";
import {
  violation,
  type OntologyContext,
  type OntologyViolation,
  type OntologyNode,
  type OntologyType,
} from "./ontology-model";
function auditBody(
  node: OntologyNode,
  typeId: string,
  schema: ReturnType<typeof documentSchema>,
): OntologyViolation[] {
  try {
    const result = schema.safeParse(JSON.parse(node.body ?? ""));
    if (result.success) return [];
    return result.error.issues
      .slice(0, 8)
      .map((issue) =>
        violation(
          node.id,
          "body.schema",
          `body.${issue.path.join(".")}`,
          issue.message,
          [typeId],
        ),
      );
  } catch {
    return [
      violation(
        node.id,
        "body.schema",
        "body",
        "Use a JSON body matching the node type's schema.",
        [typeId],
      ),
    ];
  }
}
function auditType(
  type: OntologyType,
  nodes: OntologyNode[],
): OntologyViolation[] {
  if (type.archived || !type.jsonSchema) return [];
  try {
    const schema = documentSchema(type.jsonSchema);
    return nodes
      .filter((node) => !node.archived && node.typeId === type.id)
      .flatMap((node) => auditBody(node, type.id, schema));
  } catch {
    return [
      violation(
        type.id,
        "body.schema",
        "jsonSchema",
        "The body JSON Schema cannot be loaded.",
      ),
    ];
  }
}
/** Enforce shape on the same before/after graph as every other ontology rule. */
export function auditStructuredBodies(
  ctx: OntologyContext,
): OntologyViolation[] {
  return ctx.graph.types.flatMap((type) => auditType(type, ctx.graph.nodes));
}
