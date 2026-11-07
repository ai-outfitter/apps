import { auditStructuredBodies } from "./structured-body-validation";
import { auditDefinitions } from "./ontology-definitions";
import { auditRecords, auditAssertion } from "./ontology-records";
import { auditIdentities } from "./ontology-identity";
import {
  ontologyContext,
  v2,
  type OntologyContext,
  type OntologyGraph,
  type OntologyViolation,
} from "./ontology-model";
export type { OntologyViolation, OntologyGraph } from "./ontology-model";

/** Read-only audit of explicit constraints. Historical assertions stay pinned. */
export function auditOntology(graph: OntologyGraph): OntologyViolation[] {
  return auditContext(ontologyContext(graph));
}
/** The audit with one type's contract replaced by a proposed one, written nowhere. */
export function auditProposal(graph: OntologyGraph, proposal: { typeId: string; ontology: OntologyGraph["types"][number]["ontology"] }) {
  if (!graph.types.some((type) => type.id === proposal.typeId)) throw new Response("Type not found", { status: 404 });
  return auditOntology({ ...graph, types: graph.types.map((type) => (type.id === proposal.typeId ? { ...type, ontology: proposal.ontology } : type)) });
}
export function auditContext(ctx: OntologyContext): OntologyViolation[] {
  return [
    ...auditDefinitions(ctx),
    ...auditStructuredBodies(ctx),
    ...auditRecords(ctx),
    ...auditIdentities(ctx),
  ];
}

function typeDependencies(declaration: Parameters<typeof v2>[0]): string[] {
  const contract = v2(declaration);
  return [
    ...(declaration?.endpoints?.from ?? []),
    ...(declaration?.endpoints?.to ?? []),
    ...(contract?.participation?.slots.flatMap((s) => [
      s.edgeTypeId,
      ...s.participantTypes,
    ]) ?? []),
    ...(contract?.projection ? [contract.projection.relatorTypeId] : []),
  ];
}
function changedTypes(ctx: OntologyContext, refs: Map<string, string>) {
  const affected = new Set(refs.keys());
  for (let count = 0; count < ctx.graph.types.length; count++) {
    const size = affected.size;
    for (const [id, declaration] of ctx.contracts) {
      if (typeDependencies(declaration).some((typeId) => affected.has(typeId)))
        affected.add(id);
    }
    if (size === affected.size) break;
  }
  return affected;
}
function affectedRecords(ctx: OntologyContext, refs: Map<string, string>) {
  const affected = changedTypes(ctx, refs);
  for (const node of ctx.graph.nodes)
    if (affected.has(node.typeId)) affected.add(node.id);
  const changedNodes = new Set(affected);
  const incident = ctx.graph.edges.filter(
    (edge) =>
      affected.has(edge.typeId) ||
      refs.has(edge.id) ||
      changedNodes.has(edge.fromId) ||
      changedNodes.has(edge.toId),
  );
  for (const edge of incident) {
    affected.add(edge.id);
    if (
      v2(ctx.contracts.get(ctx.nodes.get(edge.fromId)?.typeId ?? ""))
        ?.stereotype === "relator"
    )
      affected.add(edge.fromId);
  }
  return affected;
}

function errorReferences(
  error: OntologyViolation,
  ctx: OntologyContext,
  refs: Map<string, string>,
) {
  const edge = ctx.edges.get(error.recordId);
  const node = ctx.nodes.get(error.recordId);
  const involved = [
    error.recordId,
    ...(error.relatedRecordIds ?? []),
    ...(edge ? [edge.typeId, edge.fromId, edge.toId] : []),
    ...(node ? [node.typeId] : []),
  ];
  return [
    ...new Set(
      involved.flatMap((id) => {
        const ref = refs.get(id);
        return ref ? [ref] : [];
      }),
    ),
  ];
}

export function requireOntologyValid(
  before: OntologyGraph,
  after: OntologyGraph,
  refs: Map<string, string> = new Map(),
) {
  const key = (v: OntologyViolation) => `${v.recordId}|${v.rule}|${v.path}`;
  const beforeContext = ontologyContext(before);
  const existing = new Set(auditContext(beforeContext).map(key));
  const ctx = ontologyContext(after),
    affected = new Set([
      ...affectedRecords(ctx, refs),
      ...affectedRecords(beforeContext, refs),
    ]);
  const errors = auditContext(ctx).filter(
    (v) => affected.has(v.recordId) || !existing.has(key(v)),
  );
  for (const node of after.nodes) {
    if (
      refs.has(node.id) &&
      v2(ctx.contracts.get(node.typeId))?.stereotype === "assertion"
    )
      errors.push(...auditAssertion(node, ctx, true));
  }
  const distinct = [
    ...new Map(errors.map((error) => [key(error), error])).values(),
  ];
  if (distinct.length)
    throw Response.json(
      {
        code: "ontology_validation_failed",
        errors: distinct.map((error) => ({
          ...error,
          operationRefs: errorReferences(error, ctx, refs),
        })),
      },
      {
        status: distinct.every((e) => e.rule.endsWith(".duplicate"))
          ? 409
          : 400,
      },
    );
}
