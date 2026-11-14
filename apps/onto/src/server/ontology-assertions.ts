import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  sha256Hex,
  type AppActor,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import { requireMemberReview } from "./graph-batches";
import { canonical } from "../lib/canonical-json";
import { subjectSnapshot, type assertionInspectInput, type assertionConfirmInput } from "../lib/assertion-contract";
export { assertionInspection, assertionInspectInput, assertionConfirmInput } from "../lib/assertion-contract";
import { ontologyContext, v2, type OntologyNode, type OntologyEdge } from "../lib/ontology-model";
import { parseAssertion, auditAssertion } from "../lib/ontology-records";
import { graphAssertionConfirmations } from "./schema";
import { graphUnchanged, readGraph, type Database } from "./graph";


async function hashSubject(
  ctx: ReturnType<typeof ontologyContext>,
  subject: { type: string; id: string },
  record: OntologyNode | OntologyEdge,
) {
  const { graph } = ctx;
  const contract = v2(ctx.contracts.get(record.typeId));
  const slotTypes = new Set(
    contract?.participation?.slots.map((s) => s.edgeTypeId),
  );
  const links =
    subject.type === "graph-node"
      ? graph.edges.filter(
          (e) =>
            !e.archived && e.fromId === record.id && slotTypes.has(e.typeId),
        )
      : [];
  const endpointIds =
    subject.type === "graph-edge" && "fromId" in record
      ? [record.fromId, record.toId]
      : links.map((e) => e.toId);
  const participants = graph.nodes.filter((n) => endpointIds.includes(n.id));
  const typeIds = new Set([
    record.typeId,
    ...participants.map((n) => n.typeId),
    ...links.map((e) => e.typeId),
  ]);
  const snapshot = JSON.parse(
    JSON.stringify({
      record,
      links: links.sort((a, b) => a.id.localeCompare(b.id)),
      participants,
      types: graph.types.filter((t) => typeIds.has(t.id)),
    }),
  );
  return {
    subjectHash: await sha256Hex(canonical(snapshot)),
    subjectSnapshot: subjectSnapshot.parse(snapshot),
  };
}

async function readAssertion(db: Database, who: AppIdentity, id: string) {
  const graph = await readGraph(db, who),
    ctx = ontologyContext(graph);
  const node = graph.nodes.find((row) => row.id === id);
  if (!node || v2(ctx.contracts.get(node.typeId))?.stereotype !== "assertion")
    throw new Response("Assertion not found", { status: 404 });
  const parsed = parseAssertion(node);
  if (!parsed.success || auditAssertion(node, ctx).length)
    throw new Response("Invalid assertion; audit and repair its body", {
      status: 400,
    });
  const subject = parsed.data.subject;
  const target =
    subject.type === "graph-node"
      ? ctx.nodes.get(subject.id)
      : ctx.edges.get(subject.id);
  if (!target) throw new Response("Subject not found", { status: 404 });
  const { subjectHash, subjectSnapshot } = await hashSubject(ctx, subject, target);
  return {
    graph,
    node,
    assertion: parsed.data,
    subjectCurrent: !target.archived && target.revision === subject.revision,
    subjectHash,
    subjectSnapshot,
  };
}
export async function inspectAssertion(
  db: Database,
  who: AppIdentity,
  input: z.infer<typeof assertionInspectInput>,
) {
  const { node, assertion, subjectCurrent, subjectHash, subjectSnapshot } =
    await readAssertion(db, who, input.id);
  const rows = await db
    .select()
    .from(graphAssertionConfirmations)
    .where(
      and(
        eq(graphAssertionConfirmations.assertionId, node.id),
        input.includeHistory
          ? undefined
          : eq(graphAssertionConfirmations.assertionRevision, node.revision),
      ),
    )
    .orderBy(
      desc(graphAssertionConfirmations.assertionRevision),
      desc(graphAssertionConfirmations.confirmedAt),
    )
    .limit(101);
  const hash = await sha256Hex(node.body);
  const [current] = await db
    .select({ id: graphAssertionConfirmations.assertionId })
    .from(graphAssertionConfirmations)
    .where(
      and(
        eq(graphAssertionConfirmations.assertionId, node.id),
        eq(graphAssertionConfirmations.assertionRevision, node.revision),
        eq(graphAssertionConfirmations.assertionHash, hash),
        eq(graphAssertionConfirmations.subjectHash, subjectHash),
      ),
    )
    .limit(1);
  const confirmed =
    !node.archived &&
    assertion.status === "proposed" &&
    subjectCurrent &&
    !!current;
  return {
    id: node.id,
    revision: node.revision,
    assertion,
    subjectCurrent,
    subjectHash,
    subjectSnapshot,
    confirmed,
    historyTruncated: rows.length > 100,
    confirmations: rows.slice(0, 100).map((row) => ({
      ...row,
      confirmedAt: new Date(row.confirmedAt).toISOString(),
    })),
  };
}
export async function confirmAssertion(
  db: Database,
  who: AppIdentity,
  actor: AppActor,
  origin: AppActor,
  input: z.infer<typeof assertionConfirmInput>,
) {
  requireMemberReview(who, actor, origin);
  const {
    graph,
    node,
    assertion,
    subjectCurrent,
    subjectHash,
    subjectSnapshot,
  } = await readAssertion(db, who, input.id);
  if (node.archived || assertion.status !== "proposed")
    throw new Response("Only active proposed assertions may be confirmed", {
      status: 400,
    });
  if (
    node.revision !== input.revision ||
    !subjectCurrent ||
    input.subjectHash !== subjectHash
  )
    throw new Response(
      "Assertion or subject changed; review current revisions",
      { status: 409 },
    );
  const hash = await sha256Hex(node.body),
    now = Date.now();
  await db.run(sql`INSERT INTO graph_assertion_confirmations(assertionId,assertionRevision,userId,assertionHash,subjectHash,assertionBody,subjectSnapshot,confirmedAt)
    SELECT ${node.id},${node.revision},${who.userId},${hash},${subjectHash},${node.body},${JSON.stringify(subjectSnapshot)},${now} WHERE ${graphUnchanged(graph)}
    ON CONFLICT(assertionId,assertionRevision,subjectHash,userId) DO NOTHING`);
  const [ownReceipt] = await db.select({ id: graphAssertionConfirmations.assertionId })
    .from(graphAssertionConfirmations).where(and(
      eq(graphAssertionConfirmations.assertionId, node.id),
      eq(graphAssertionConfirmations.assertionRevision, node.revision),
      eq(graphAssertionConfirmations.userId, who.userId),
      eq(graphAssertionConfirmations.assertionHash, hash),
      eq(graphAssertionConfirmations.subjectHash, subjectHash),
    )).limit(1);
  if (!ownReceipt) throw new Response("Graph changed; review current revisions before confirming", { status: 409 });
  const result = await inspectAssertion(db, who, {
    id: node.id,
    includeHistory: false,
  });
  if (
    !result.confirmed ||
    result.revision !== node.revision ||
    result.subjectHash !== subjectHash
  )
    throw new Response(
      "Graph changed; review current revisions before confirming",
      { status: 409 },
    );
  return result;
}
