import type { OntologyV2 } from "@ai-outfitter/onto/contracts";
import {
  type OntologyContext,
  type OntologyType,
  type OntologyViolation,
  v2,
  violation,
} from "./ontology-model";
import { measureDefinitions } from "./ontology-measures";

function endpointDefinitions(
  type: OntologyType,
  ctx: OntologyContext,
): OntologyViolation[] {
  const endpoints = ctx.contracts.get(type.id)?.endpoints;
  if (!endpoints) return [];
  const errors: OntologyViolation[] = [];
  if (type.category !== "edge")
    errors.push(
      violation(
        type.id,
        "contract.category",
        "ontology.endpoints",
        "Endpoint constraints require an edge type.",
      ),
    );
  for (const [side, ids] of Object.entries(endpoints)) {
    for (const id of ids) {
      if (ctx.types.get(id)?.category !== "node")
        errors.push(
          violation(
            type.id,
            "contract.endpoint_type",
            `ontology.endpoints.${side}.${id}`,
            "Endpoint type must identify an existing node type.",
          ),
        );
    }
  }
  return errors;
}

function auditSlotDefinition(
  type: OntologyType,
  slot: NonNullable<OntologyV2["participation"]>["slots"][number],
  ctx: OntologyContext,
): OntologyViolation[] {
  const errors: OntologyViolation[] = [];
  const path = `ontology.participation.slots.${slot.name}`;
  if (slot.max !== null && slot.min > slot.max)
    errors.push(
      violation(
        type.id,
        "participation.bounds",
        path,
        "Minimum cardinality must not exceed maximum.",
      ),
    );
  const edge = ctx.types.get(slot.edgeTypeId),
    edgeContract = v2(ctx.contracts.get(slot.edgeTypeId));
  if (
    edge?.category !== "edge" ||
    edgeContract?.projection ||
    edgeContract?.symmetric
  )
    errors.push(
      violation(
        type.id,
        "participation.edge_type",
        path,
        "A slot requires a direct, directed edge type.",
      ),
    );
  for (const id of slot.participantTypes) {
    if (ctx.types.get(id)?.category !== "node")
      errors.push(
        violation(
          type.id,
          "participation.participant_type",
          path,
          "Participant types must identify existing node types.",
        ),
      );
  }
  const endpoints = ctx.contracts.get(slot.edgeTypeId)?.endpoints;
  if (
    endpoints &&
    (!endpoints.from.includes(type.id) ||
      slot.participantTypes.some((id) => !endpoints.to.includes(id)))
  )
    errors.push(
      violation(
        type.id,
        "participation.endpoints",
        path,
        "Slot types must agree with the connection's declared endpoints.",
      ),
    );
  return errors;
}

function slotDefinitions(
  type: OntologyType,
  contract: OntologyV2,
  ctx: OntologyContext,
): OntologyViolation[] {
  const participation = contract.participation;
  if (!participation) return [];
  const errors: OntologyViolation[] = [];
  const names = new Set<string>(),
    edgeTypes = new Set<string>();
  for (const slot of participation.slots) {
    const path = `ontology.participation.slots.${slot.name}`;
    if (names.has(slot.name) || edgeTypes.has(slot.edgeTypeId))
      errors.push(
        violation(
          type.id,
          "participation.duplicate_slot",
          path,
          "Slots require unique names and connection types.",
        ),
      );
    names.add(slot.name);
    edgeTypes.add(slot.edgeTypeId);
    errors.push(...auditSlotDefinition(type, slot, ctx));
  }
  const groups = [
    ...(participation.distinct ?? []),
    ...(participation.uniqueBy ? [participation.uniqueBy] : []),
  ];
  for (const group of groups) {
    if (
      new Set(group).size !== group.length ||
      group.some((name) => !names.has(name))
    )
      errors.push(
        violation(
          type.id,
          "participation.slot_reference",
          "ontology.participation",
          "Distinct and uniqueBy groups must name declared slots exactly once.",
        ),
      );
  }
  return errors;
}

function projectionDefinition(
  type: OntologyType,
  contract: OntologyV2,
  ctx: OntologyContext,
): OntologyViolation[] {
  const projection = contract.projection;
  if (!projection) return [];
  const relator = v2(ctx.contracts.get(projection.relatorTypeId));
  const names = relator?.participation?.slots.map((slot) => slot.name) ?? [];
  const valid =
    type.category === "edge" &&
    relator?.stereotype === "relator" &&
    names.includes(projection.fromSlot) &&
    names.includes(projection.toSlot);
  if (!valid)
    return [
      violation(
        type.id,
        "projection.slots",
        "ontology.projection",
        "A projection requires an existing relator and declared participant slots.",
      ),
    ];
  if (
    contract.symmetric !== undefined ||
    contract.validity ||
    contract.endpoints ||
    contract.stereotype ||
    contract.participation
  )
    return [
      violation(
        type.id,
        "projection.declaration",
        "ontology.projection",
        "A projection derives its endpoints, symmetry and validity from its declaration and relator.",
      ),
    ];
  if (projection.fromSlot === projection.toSlot && !projection.symmetric)
    return [
      violation(
        type.id,
        "projection.direction",
        "ontology.projection",
        "A same-slot projection must be symmetric.",
      ),
    ];
  return [];
}

function classifications(
  type: OntologyType,
  contract: OntologyV2,
): OntologyViolation[] {
  const errors: OntologyViolation[] = [];
  if (contract.stereotype && type.category !== "node")
    errors.push(
      violation(
        type.id,
        "contract.stereotype",
        "ontology.stereotype",
        "Stereotypes classify node types.",
      ),
    );
  if (
    (contract.participation && contract.stereotype !== "relator") ||
    (contract.stereotype === "relator" && !contract.participation)
  )
    errors.push(
      violation(
        type.id,
        "contract.participation",
        "ontology.participation",
        "Relators require participation declarations; participation belongs to relators.",
      ),
    );
  if (contract.symmetric !== undefined && type.category !== "edge")
    errors.push(
      violation(
        type.id,
        "contract.symmetry",
        "ontology.symmetric",
        "Symmetry belongs to edge types.",
      ),
    );
  if (
    contract.symmetric &&
    JSON.stringify([...new Set(contract.endpoints?.from ?? [])].sort()) !==
      JSON.stringify([...new Set(contract.endpoints?.to ?? [])].sort())
  )
    errors.push(
      violation(
        type.id,
        "contract.symmetric_endpoints",
        "ontology.endpoints",
        "Symmetric endpoints must permit the same node types on both sides.",
      ),
    );
  if (contract.symmetric && !contract.endpoints)
    errors.push(
      violation(
        type.id,
        "contract.symmetric_endpoints",
        "ontology.endpoints",
        "Symmetric relationships require explicit endpoint types.",
      ),
    );
  return errors;
}

export function auditDefinitions(ctx: OntologyContext): OntologyViolation[] {
  return ctx.graph.types.flatMap((type) => {
    if (type.ontology === undefined) return [];
    if (!ctx.contracts.has(type.id))
      return [
        violation(
          type.id,
          "contract.unsupported",
          "ontology",
          "Unsupported or invalid ontology contract.",
        ),
      ];
    const contract = v2(ctx.contracts.get(type.id));
    return [
      ...endpointDefinitions(type, ctx),
      ...(contract
        ? [
            ...classifications(type, contract),
            ...slotDefinitions(type, contract, ctx),
            ...projectionDefinition(type, contract, ctx),
            ...measureDefinitions(type, contract, ctx),
          ]
        : []),
    ];
  });
}
