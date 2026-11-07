import {
  assertionBody,
  validityInterval,
  type OntologyV2,
} from "@ai-outfitter/app-sdk/wiki";
import {
  type OntologyContext,
  type OntologyNode,
  type OntologyEdge,
  type OntologyViolation,
  v2,
  intervalBounds,
  violation,
} from "./ontology-model";

export function parseAssertion(node: Pick<OntologyNode, "body">) {
  try {
    return assertionBody.safeParse(JSON.parse(node.body ?? ""));
  } catch {
    return assertionBody.safeParse(null);
  }
}

function auditValidity(
  row: OntologyNode | OntologyEdge,
  ctx: OntologyContext,
): OntologyViolation[] {
  if (!row.validity) return [];
  const contract = v2(ctx.contracts.get(row.typeId));
  if (contract?.validity !== "interval")
    return [
      violation(
        row.id,
        "validity.undeclared",
        "validity",
        "Declare interval validity on this type before adding business dates.",
      ),
    ];
  if (!validityInterval.safeParse(row.validity).success)
    return [
      violation(
        row.id,
        "validity.invalid",
        "validity",
        "Use ISO date-time endpoints or null for an unbounded interval.",
      ),
    ];
  const [from, to] = intervalBounds(row.validity);
  return from < to
    ? []
    : [
        violation(
          row.id,
          "validity.order",
          "validity",
          "Business validity must have from before to; the end is exclusive.",
        ),
      ];
}

export function auditAssertion(
  node: OntologyNode,
  ctx: OntologyContext,
  exactRevision = false,
): OntologyViolation[] {
  const parsed = parseAssertion(node);
  if (!parsed.success)
    return [
      violation(
        node.id,
        "assertion.payload",
        "body",
        "Use the structured assertion schema; confirmation is a server receipt, not an editable field.",
      ),
    ];
  const { subject } = parsed.data;
  const target =
    subject.type === "graph-node"
      ? ctx.nodes.get(subject.id)
      : ctx.edges.get(subject.id);
  if (!target || subject.id === node.id)
    return [
      violation(
        node.id,
        "assertion.subject",
        "body.subject",
        "An assertion must reference another existing record in this Wiki.",
      ),
    ];
  if (
    subject.revision > (target.revision ?? 1) ||
    (exactRevision && subject.revision !== (target.revision ?? 1))
  )
    return [
      violation(
        node.id,
        "assertion.subject_revision",
        "body.subject.revision",
        "Read and reference the subject's current revision before saving this assertion.",
        [subject.id],
      ),
    ];
  return [];
}

export function participationEdges(
  node: OntologyNode,
  slot: NonNullable<OntologyV2["participation"]>["slots"][number],
  ctx: OntologyContext,
) {
  return (ctx.outgoing.get(node.id) ?? []).filter(
    (edge) =>
      !edge.archived &&
      edge.fromId === node.id &&
      edge.typeId === slot.edgeTypeId,
  );
}

function auditSlot(
  node: OntologyNode,
  slot: NonNullable<OntologyV2["participation"]>["slots"][number],
  ctx: OntologyContext,
): OntologyViolation[] {
  const edges = participationEdges(node, slot, ctx);
  const errors: OntologyViolation[] = [];
  const path = `participants.${slot.name}`;
  if (edges.length < slot.min)
    errors.push(
      violation(
        node.id,
        "participation.minimum",
        path,
        `${slot.name} requires at least ${slot.min} participant(s); found ${edges.length}.`,
        edges.map((e) => e.id),
      ),
    );
  if (slot.max !== null && edges.length > slot.max)
    errors.push(
      violation(
        node.id,
        "participation.maximum",
        path,
        `${slot.name} permits at most ${slot.max} participant(s); found ${edges.length}.`,
        edges.map((e) => e.id),
      ),
    );
  for (const edge of edges) {
    const participant = ctx.nodes.get(edge.toId);
    if (
      !participant ||
      participant.archived ||
      !slot.participantTypes.includes(participant.typeId)
    )
      errors.push(
        violation(
          node.id,
          "participation.type",
          path,
          `${slot.name} requires an active participant of an allowed type.`,
          [edge.id, edge.toId],
        ),
      );
    if (edge.validity)
      errors.push(
        violation(
          node.id,
          "participation.validity",
          path,
          "Slot membership follows its relator's validity; put business dates on the relator.",
          [edge.id],
        ),
      );
  }
  return errors;
}

function auditDistinct(
  node: OntologyNode,
  contract: OntologyV2,
  ctx: OntologyContext,
): OntologyViolation[] {
  return (contract.participation?.distinct ?? []).flatMap((group) => {
    const slots =
      contract.participation?.slots.filter((slot) =>
        group.includes(slot.name),
      ) ?? [];
    const edges = slots.flatMap((slot) => participationEdges(node, slot, ctx));
    if (new Set(edges.map((e) => e.toId)).size === edges.length) return [];
    return [
      violation(
        node.id,
        "participation.distinct",
        `participants.${group.join("+")}`,
        "These slots require distinct participants.",
        edges.map((e) => e.id),
      ),
    ];
  });
}

export function auditRelator(
  node: OntologyNode,
  contract: OntologyV2,
  ctx: OntologyContext,
): OntologyViolation[] {
  if (node.archived) return [];
  return [
    ...(contract.participation?.slots.flatMap((slot) =>
      auditSlot(node, slot, ctx),
    ) ?? []),
    ...auditDistinct(node, contract, ctx),
  ];
}

function auditEndpoints(
  edge: OntologyEdge,
  ctx: OntologyContext,
): OntologyViolation[] {
  if (edge.archived) return [];
  const endpoints = ctx.contracts.get(edge.typeId)?.endpoints;
  if (!endpoints) return [];
  return (["from", "to"] as const).flatMap((side) => {
    const node = ctx.nodes.get(side === "from" ? edge.fromId : edge.toId);
    return node && !node.archived && endpoints[side].includes(node.typeId)
      ? []
      : [
          violation(
            edge.id,
            `endpoint.${side}`,
            `${side}Id`,
            `Choose an active ${side} endpoint of an allowed type.`,
          ),
        ];
  });
}

function auditNode(
  node: OntologyNode,
  ctx: OntologyContext,
): OntologyViolation[] {
  const contract = v2(ctx.contracts.get(node.typeId));
  return [
    ...auditValidity(node, ctx),
    ...(contract?.stereotype === "relator"
      ? auditRelator(node, contract, ctx)
      : []),
    ...(contract?.stereotype === "assertion" ? auditAssertion(node, ctx) : []),
  ];
}
function auditEdge(
  edge: OntologyEdge,
  ctx: OntologyContext,
): OntologyViolation[] {
  const contract = v2(ctx.contracts.get(edge.typeId));
  if (contract?.projection)
    return [
      violation(
        edge.id,
        "projection.read_only",
        "typeId",
        "Derived relationships cannot be stored or edited; edit the source relator instead.",
      ),
    ];
  return [
    ...(edge.fromId === edge.toId
      ? [
          violation(
            edge.id,
            "relationship.distinct",
            "fromId",
            "Choose two different entities.",
          ),
        ]
      : []),
    ...auditValidity(edge, ctx),
    ...auditEndpoints(edge, ctx),
  ];
}
export function auditRecords(ctx: OntologyContext): OntologyViolation[] {
  const records = [...ctx.graph.nodes, ...ctx.graph.edges];
  const unsupported = records.filter(
    (row) =>
      ctx.types.get(row.typeId)?.ontology !== undefined &&
      !ctx.contracts.has(row.typeId),
  );
  return [
    ...unsupported.map((row) =>
      violation(
        row.id,
        "contract.unsupported",
        "typeId",
        "Record uses an unsupported ontology contract.",
      ),
    ),
    ...ctx.graph.nodes.flatMap((node) => auditNode(node, ctx)),
    ...ctx.graph.edges.flatMap((edge) => auditEdge(edge, ctx)),
  ];
}
