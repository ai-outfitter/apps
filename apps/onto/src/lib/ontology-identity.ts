import {
  type OntologyContext,
  type OntologyNode,
  type OntologyViolation,
  intervalsOverlap,
  intervalBounds,
  unorderedPair,
  v2,
  violation,
} from "./ontology-model";
import { auditRelator, participationEdges } from "./ontology-records";

function overlapping<
  T extends { id: string; validity?: OntologyNode["validity"] },
>(rows: T[], rule: string): OntologyViolation[] {
  const errors: OntologyViolation[] = [];
  rows = [...rows].sort(
    (a, b) => intervalBounds(a.validity)[0] - intervalBounds(b.validity)[0],
  );
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const first = rows[i],
        second = rows[j];
      if (
        intervalBounds(second.validity)[0] >= intervalBounds(first.validity)[1]
      )
        break;
      if (!intervalsOverlap(first.validity, second.validity)) continue;
      errors.push(
        violation(
          first.id,
          rule,
          "identity",
          "This participant identity overlaps another relationship's business validity.",
          [second.id],
        ),
      );
      errors.push(
        violation(
          second.id,
          rule,
          "identity",
          "This participant identity overlaps another relationship's business validity.",
          [first.id],
        ),
      );
    }
  }
  return errors;
}
export function auditIdentities(ctx: OntologyContext): OntologyViolation[] {
  const edges = new Map<string, typeof ctx.graph.edges>();
  for (const edge of ctx.graph.edges.filter((e) => !e.archived)) {
    const symmetric = v2(ctx.contracts.get(edge.typeId))?.symmetric;
    const pair = symmetric
      ? unorderedPair(edge.fromId, edge.toId)
      : [edge.fromId, edge.toId];
    const key = JSON.stringify([edge.typeId, ...pair]);
    const group = edges.get(key) ?? [];
    group.push(edge);
    edges.set(key, group);
  }
  const relators = new Map<string, OntologyNode[]>();
  for (const node of ctx.graph.nodes.filter((n) => !n.archived)) {
    const contract = v2(ctx.contracts.get(node.typeId));
    const uniqueBy = contract?.participation?.uniqueBy;
    if (!uniqueBy || !contract || auditRelator(node, contract, ctx).length)
      continue;
    const participants = uniqueBy.map((name) => {
      const slot = contract.participation?.slots.find((s) => s.name === name);
      return slot
        ? participationEdges(node, slot, ctx)
            .map((e) => e.toId)
            .sort()
        : [];
    });
    const key = JSON.stringify([node.typeId, participants]);
    const group = relators.get(key) ?? [];
    group.push(node);
    relators.set(key, group);
  }
  return [
    ...[...edges.values()].flatMap((group) =>
      overlapping(group, "relationship.duplicate"),
    ),
    ...[...relators.values()].flatMap((group) =>
      overlapping(group, "relator.duplicate"),
    ),
  ];
}
