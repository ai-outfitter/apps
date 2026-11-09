import { endpointAllows, type OntologyMeasure, type OntologyV2 } from "@ai-outfitter/app-sdk/graph-contracts";
import { type OntologyContext, type OntologyType, type OntologyViolation, v2, violation } from "./ontology-model";

type Count = Extract<OntologyMeasure["expression"], { op: "count" }>;
// Types read without names or field lists (older callers) skip reference checks.
const declares = (type: OntologyType | undefined, key: string) => !type?.properties || type.properties.some((p) => p.name === key);
const numeric = (type: OntologyType, key: string) => !type.properties || type.properties.some((p) => p.name === key && p.type === "number");

/** The records a count measure ranges over: undefined when `of` names nothing
 * reachable, "ambiguous" when it names more than one relator slot or edge type. */
export function countTarget(type: OntologyType, expression: Count, ctx: OntologyContext): OntologyType | null | undefined | "ambiguous" {
  if (!expression.of) return type;
  const direction = expression.direction ?? "incoming";
  const relators = direction === "incoming"
    ? [...ctx.contracts].filter(([, contract]) => v2(contract)?.participation?.slots.some((s) => s.name === expression.of && s.participantTypes.includes(type.id)))
    : [];
  const edge = ctx.graph.types.find((t) => t.category === "edge" && t.name === expression.of);
  const endpoints = edge && ctx.contracts.get(edge.id)?.endpoints;
  const edges = edge && (!endpoints || endpointAllows(endpoints[direction === "incoming" ? "to" : "from"], type.id)) ? [edge] : [];
  const targets = [...relators.map(([id]) => ctx.types.get(id)), ...edges];
  if (targets.length > 1) return "ambiguous";
  if (targets.length) return targets[0];
  return !edge && ctx.graph.types.some((t) => t.name === undefined) ? null : undefined;
}

function auditMeasure(type: OntologyType, measure: OntologyMeasure, ctx: OntologyContext): OntologyViolation[] {
  const path = `ontology.measures.${measure.name}`, e = measure.expression;
  const missing = (key: string) => violation(type.id, "measure.property", path, `Declare the property ${key} on this type before measuring it.`);
  if (e.op === "sum" || e.op === "min" || e.op === "max") {
    if (!declares(type, e.property)) return [missing(e.property)];
    return numeric(type, e.property) ? [] : [violation(type.id, "measure.property", path, `Declare ${e.property} as a number before taking its ${e.op}.`)];
  }
  if (e.op === "formula") return Object.values(e.fields).filter((key) => key && !declares(type, key)).map((key) => missing(String(key)));
  if (e.op !== "count") return [];
  const target = countTarget(type, e, ctx);
  if (target === undefined)
    return [violation(type.id, "measure.reference", path, "Count a relator slot that targets this type or an edge type that reaches it.")];
  if (target === "ambiguous")
    return [violation(type.id, "measure.reference", path, `${e.of} names more than one relator slot or edge type here; rename one so the count is unambiguous.`)];
  return e.where && target && !declares(target, e.where.property) ? [missing(e.where.property)] : [];
}

export function measureDefinitions(type: OntologyType, contract: OntologyV2, ctx: OntologyContext): OntologyViolation[] {
  return (contract.measures ?? []).flatMap((measure) => auditMeasure(type, measure, ctx));
}
