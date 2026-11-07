import type {
  AgentDatabase,
  AgentStatement,
} from "@ai-outfitter/app-sdk/agent-store";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import {
  requireEditor,
  sha256Hex,
  type AppIdentity,
} from "@ai-outfitter/app-sdk/server";
import {
  graphChangeInput,
  sourceFenceProof,
  sourceFenceDefinition,
  type SourceFenceDefinition,
  type SourceFenceProof,
} from "@ai-outfitter/onto/contracts";
import type { z } from "zod";
import { stableGraphId } from "@ai-outfitter/onto/client";
import { canonical } from "../../lib/canonical-json";
import { v2 } from "../../lib/ontology-model";
import type { TypeDefinition } from "../../lib/graph";
import { nodeView, edgeView } from "../graph";
import { graphTypes, graphNodes, graphEdges } from "../schema";
import { readType } from "../../lib/type-metadata";
import { and, asc, eq } from "drizzle-orm";
import { graphEntities } from "../graph-entities";
import { applyGraphChanges } from "../graph-changes";

export const proofType = "9c5be200-b4f8-5f33-8000-000000000001",
  sealType = "9c5be200-b4f8-5f33-8000-000000000002";
const ttl = 5 * 60_000,
  maxBytes = 512 * 1024;
type GraphInput = z.infer<typeof graphChangeInput>;
export type SourceDatabase = Parameters<typeof applyGraphChanges>[0];
type Provider = SourceFenceProof["provider"];
type Subject = SourceFenceProof["subject"];
export type SourceContext = {
  db: AgentDatabase;
  graph: SourceDatabase;
  identity: AppIdentity;
};
const stmt = (sql: string, ...params: unknown[]): AgentStatement => ({
  sql,
  params,
});
const query = async (c: SourceContext, sql: string, ...params: unknown[]) =>
  (await c.db.query(stmt(sql, ...params)))[0];
function fail(message: string, status = 409): never {
  throw new Response(message, { status });
}
const hash = (value: unknown) => sha256Hex(canonical(value));
const owner = (c: SourceContext) =>
  `${c.identity.owner.kind}:${c.identity.owner.id}`;
function authority(c: SourceContext, provider: Provider) {
  requireEditor(c.identity);
  if (
    provider.installationId !== c.identity.installationId ||
    provider.contract !== "outfitter.onto.source-fence" ||
    provider.version !== 1
  )
    fail(
      "Source provider binding differs from this authorized installation",
      403,
    );
}
async function sourceType(
  c: SourceContext,
  id: string,
): Promise<TypeDefinition | undefined> {
  const [row] = await c.graph
    .select()
    .from(graphTypes)
    .where(eq(graphTypes.id, id))
    .limit(1);
  return row ? readType(row) : undefined;
}
async function markerTypes(c: SourceContext) {
  const operations: GraphInput["operations"] = [];
  for (const [id, name] of [
    [proofType, "OntoSourceProof"],
    [sealType, "OntoSourceSeal"],
  ]) {
    const existing = await sourceType(c, id);
    if (existing) {
      if (
        existing.name !== name ||
        existing.category !== "node" ||
        existing.archived ||
        v2(existing.ontology)?.immutable !== true
      )
        fail("Source marker type conflicts with an authored definition");
    } else
      operations.push({
        operation: "create",
        ref: `$${name}`,
        type: "graph-type",
        attributes: {
          id,
          name,
          category: "node",
          title: name,
          body: "Source-local protocol marker; authority requires a server-private row and matching graph change receipt.",
          ontology: { version: 2, immutable: true },
        },
      });
  }
  if (operations.length)
    await applyGraphChanges(c.graph, c.identity, {
      requestKey: `onto-source-types:${c.identity.installationId}`,
      operations,
    });
}
export async function defineSource(
  c: SourceContext,
  provider: Provider,
  id: string,
  version: number,
  raw: SourceFenceDefinition,
) {
  authority(c, provider);
  if (
    !c.identity.role
      .split(",")
      .some((role) => ["owner", "admin"].includes(role.trim()))
  )
    fail("An owner or admin must review source definitions", 403);
  const definition = sourceFenceDefinition.parse(raw);
  if (definition.sets.some((set) => [proofType, sealType].includes(set.typeId)))
    fail("Protocol marker types cannot be captured as source sets");
  await markerTypes(c);
  const encoded = canonical(definition),
    digest = await hash(definition);
  await c.db.batch([
    stmt(
      "INSERT INTO onto_source_definitions(owner,id,version,definition,digest,installation_id) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id,version) DO NOTHING",
      owner(c),
      id,
      version,
      encoded,
      digest,
      provider.installationId,
    ),
  ]);
  const saved = await query(
    c,
    "SELECT definition,digest,installation_id FROM onto_source_definitions WHERE owner=? AND id=? AND version=?",
    owner(c),
    id,
    version,
  );
  if (
    saved?.definition !== encoded ||
    saved.digest !== digest ||
    saved.installation_id !== provider.installationId
  )
    fail("Reviewed definition version already has different content");
  return { id, version, digest };
}
async function subject(c: SourceContext, expected: Subject) {
  if (expected.installationId !== c.identity.installationId)
    fail("Subject is outside this installation", 403);
  const record = await graphEntities(c.graph, { verifiedReferences: true })
    .find((provider) => provider.type === "graph-node")!
    .get(c.identity, expected.id);
  const type = await sourceType(c, String(record.attributes.typeId));
  if (
    record.attributes.archived ||
    record.revision !== expected.revision ||
    !type ||
    type.archived ||
    v2(type.ontology)?.immutable !== true
  )
    fail("An exact retained immutable graph-node subject is required");
  if (
    (await sha256Hex(canonicalActionValue(record.attributes))) !==
    expected.digest
  )
    fail("Subject attributes digest or revision differs");
  return { type, record };
}

/** Bounded selected-set reads only. graph.apply retains its separate legacy writer validation. */
export async function readSourceSelection(
  c: SourceContext,
  definition: SourceFenceDefinition,
  expected: Subject,
) {
  requireEditor(c.identity);
  const retained = await subject(c, expected);
  const typeRows = new Map([[retained.type.id, retained.type]]);
  const nodes = new Map<string, ReturnType<typeof nodeView>>(),
    edges = new Map<string, ReturnType<typeof edgeView>>();
  const readSets: SourceFenceProof["readSets"] = [];
  const records: SourceFenceProof["records"] = [
    { type: "graph-node", id: expected.id, revision: expected.revision },
  ];
  const rememberType = async (id: string) => {
    const type = typeRows.get(id) ?? (await sourceType(c, id));
    if (!type || type.archived) fail("Selected source type unavailable");
    typeRows.set(id, type);
    return type;
  };
  const scoped = definition.selection === "direct-neighborhood-v1";
  const additional = [...definition.records];
  if (scoped) additional.push({ type: "graph-node", id: definition.rootId });
  for (const set of definition.sets) {
    const endpoint =
      scoped && "direction" in set
        ? { direction: set.direction, nodeId: definition.rootId }
        : undefined;
    const type = await rememberType(set.typeId);
    if (type.category !== (set.type === "graph-node" ? "node" : "edge"))
      fail("Selected source type changed");
    let members: { id: string; revision: number }[];
    if (set.type === "graph-node") {
      const rows = (
        await c.graph
          .select()
          .from(graphNodes)
          .where(
            and(
              eq(graphNodes.typeId, set.typeId),
              set.includeArchived ? undefined : eq(graphNodes.archived, false),
            ),
          )
          .orderBy(asc(graphNodes.id))
          .limit(2001)
      ).map(nodeView);
      members = rows.map((row) => ({ id: row.id, revision: row.revision }));
      for (const row of rows) nodes.set(row.id, row);
    } else {
      const rows = (
        await c.graph
          .select()
          .from(graphEdges)
          .where(
            and(
              eq(graphEdges.typeId, set.typeId),
              endpoint
                ? eq(
                    endpoint.direction === "outgoing"
                      ? graphEdges.fromId
                      : graphEdges.toId,
                    endpoint.nodeId,
                  )
                : undefined,
              set.includeArchived ? undefined : eq(graphEdges.archived, false),
            ),
          )
          .orderBy(asc(graphEdges.id))
          .limit(2001)
      ).map(edgeView);
      members = rows.map((row) => ({ id: row.id, revision: row.revision }));
      for (const row of rows) {
        edges.set(row.id, row);
        if (endpoint)
          additional.push({
            type: "graph-node",
            id: endpoint.direction === "outgoing" ? row.toId : row.fromId,
          });
      }
    }
    if (members.length > 2000)
      fail("Source membership exceeds 2000 records", 413);
    readSets.push({
      type: set.type,
      typeId: set.typeId,
      includeArchived: set.includeArchived,
      ...(endpoint ? { endpoint } : {}),
      records: members.sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  const uniqueAdditional = [
    ...new Map(
      additional.map((ref) => [`${ref.type}:${ref.id}`, ref]),
    ).values(),
  ];
  if (uniqueAdditional.length + typeRows.size + records.length + 1 > 100)
    fail("Source proof exceeds 100 revision preconditions", 413);
  for (const ref of uniqueAdditional) {
    let record: { id: string; typeId: string; revision: number } | undefined;
    if (ref.type === "graph-node") {
      const [raw] = await c.graph
        .select()
        .from(graphNodes)
        .where(eq(graphNodes.id, ref.id))
        .limit(1);
      if (raw) {
        const row = nodeView(raw);
        nodes.set(row.id, row);
        record = row;
      }
    } else {
      const [raw] = await c.graph
        .select()
        .from(graphEdges)
        .where(eq(graphEdges.id, ref.id))
        .limit(1);
      if (raw) {
        const row = edgeView(raw);
        edges.set(row.id, row);
        record = row;
      }
    }
    if (!record || [proofType, sealType].includes(record.typeId))
      fail("Additional evidence record unavailable");
    const recordType = await rememberType(record.typeId);
    if (recordType.category !== (ref.type === "graph-node" ? "node" : "edge"))
      fail("Evidence type category differs");
    if (
      scoped &&
      ref.id === definition.rootId &&
      (record as ReturnType<typeof nodeView>).archived
    )
      fail("Selection root is archived");
    records.push({ ...ref, revision: record.revision });
  }
  if (typeRows.size + records.length + 1 > 100)
    fail("Source proof exceeds 100 revision preconditions", 413);
  const sorted = <T extends { id: string }>(rows: T[]) =>
    rows.sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = {
    types: sorted([...typeRows.values()]),
    nodes: sorted([...nodes.values()]),
    edges: sorted([...edges.values()]),
    subject: retained.record,
  };
  return {
    snapshot,
    readSets,
    records,
    types: sorted(
      [...typeRows.values()].map((type) => ({
        type: "graph-type" as const,
        id: type.id,
        revision: type.revision,
      })),
    ),
  };
}
/** Accept a graph marker only with the exact server-stored graph.apply request receipt. */
async function verifiedReceipt(
  c: SourceContext,
  actor: string,
  input: GraphInput,
  ref: string,
  typeId: string,
) {
  const saved = await query(
    c,
    "SELECT hash,receipt FROM graph_changes WHERE userId=? AND requestKey=?",
    actor,
    input.requestKey,
  );
  if (!saved) return null;
  if (saved.hash !== (await hash(input)))
    fail("Graph receipt conflicts with its server-authored request");
  const receipt = JSON.parse(String(saved.receipt)) as Record<
    string,
    { id: string; revision: number }
  >;
  const operation = input.operations[0],
    id = String(operation.attributes.id),
    body = String(operation.attributes.body);
  if (receipt[ref]?.id !== id || receipt[ref]?.revision !== 1)
    fail("Graph receipt subject differs");
  const record = await graphEntities(c.graph, { verifiedReferences: true })
    .find((provider) => provider.type === "graph-node")!
    .get(c.identity, id);
  const type = await sourceType(c, typeId);
  if (
    record.revision !== 1 ||
    record.attributes.typeId !== typeId ||
    record.attributes.body !== body ||
    record.attributes.archived ||
    !type ||
    type.archived ||
    v2(type.ontology)?.immutable !== true
  )
    fail("Source receipt contents or immutable type differ");
  return {
    installationId: c.identity.installationId,
    type: "graph-node" as const,
    id,
    revision: 1,
    digest: await sha256Hex(canonicalActionValue(record.attributes)),
  };
}
function checkProofRequest(
  proof: SourceFenceProof,
  input: GraphInput,
  digest: string,
) {
  const expected = {
    version: 1,
    kind: "onto-source-proof",
    owner: proof.scope.owner,
    provider: proof.provider,
    proofId: proof.id,
    digest,
  };
  if (
    input.operations.length !== 1 ||
    input.operations[0].attributes.typeId !== proofType ||
    input.operations[0].attributes.body !== canonical(expected) ||
    canonical(input.readSets) !== canonical(proof.readSets) ||
    canonical(input.preconditions?.slice(0, -1)) !==
      canonical([...proof.types, ...proof.records]) ||
    input.preconditions?.at(-1)?.id !== proofType
  )
    fail("Source proof issuance receipt differs from its stored proof");
}
async function finishProof(c: SourceContext, row: Record<string, unknown>) {
  const proof = sourceFenceProof.parse(JSON.parse(String(row.proof))),
    input = graphChangeInput.parse(JSON.parse(String(row.graph_request)));
  if (
    proof.scope.owner !== owner(c) ||
    proof.scope.organizationId !== (c.identity.organizationId ?? null) ||
    proof.provider.installationId !== c.identity.installationId ||
    row.digest !== (await hash(proof))
  )
    fail("Stored source proof binding or digest differs");
  checkProofRequest(proof, input, String(row.digest));
  if (
    !(await verifiedReceipt(c, String(row.actor), input, "$proof", proofType))
  ) {
    if (Date.now() >= proof.expiresAt)
      fail("Source proof expired before issuance");
    if (row.actor !== c.identity.userId)
      fail("Only the initiating member may resume an uncommitted capture", 403);
    await applyGraphChanges(c.graph, c.identity, input);
    if (
      !(await verifiedReceipt(c, String(row.actor), input, "$proof", proofType))
    )
      fail("Source proof receipt unavailable", 503);
  }
  await c.db.batch([
    stmt(
      "UPDATE onto_source_proofs SET state='issued' WHERE owner=? AND id=? AND digest=?",
      owner(c),
      proof.id,
      row.digest,
    ),
  ]);
  return proof;
}
export async function captureSource(
  c: SourceContext,
  provider: Provider,
  definitionId: string,
  definitionVersion: number,
  requestKey: string,
  expected: Subject,
) {
  authority(c, provider);
  const requestHash = await hash({
    provider,
    definitionId,
    definitionVersion,
    subject: expected,
  });
  const prior = await query(
    c,
    "SELECT * FROM onto_source_proofs WHERE owner=? AND actor=? AND request_key=?",
    owner(c),
    c.identity.userId,
    requestKey,
  );
  if (prior) {
    if (prior.request_hash !== requestHash)
      fail("Capture key already used for a different subject or definition");
    return finishProof(c, prior);
  }
  const saved = await query(
    c,
    "SELECT * FROM onto_source_definitions WHERE owner=? AND id=? AND version=?",
    owner(c),
    definitionId,
    definitionVersion,
  );
  if (!saved || saved.installation_id !== provider.installationId)
    fail("Reviewed source definition unavailable", 404);
  const definition = sourceFenceDefinition.parse(
    JSON.parse(String(saved.definition)),
  );
  if (saved.digest !== (await hash(definition)))
    fail("Reviewed definition digest differs");
  const { types, readSets, records, snapshot } = await readSourceSelection(
    c,
    definition,
    expected,
  );
  const proofId = await stableGraphId(
    "onto-source-proof-v1",
    owner(c),
    c.identity.installationId,
    c.identity.userId,
    requestKey,
  );
  const proof = sourceFenceProof.parse({
    version: 1,
    id: proofId,
    provider,
    scope: {
      owner: owner(c),
      organizationId: c.identity.organizationId ?? null,
    },
    selection: {
      definitionId,
      definitionVersion,
      definitionDigest: saved.digest,
      kind: definition.selection,
    },
    subject: expected,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    completeness: { complete: true, errors: [] },
    types,
    readSets,
    records,
    snapshot,
    snapshotDigest: await hash(snapshot),
  });
  if (
    new TextEncoder().encode(canonical(proof)).length > maxBytes ||
    proof.types.length + records.length + 1 > 100
  )
    fail("Source proof exceeds bounded capture limits", 413);
  const digest = await hash(proof),
    marker = await sourceType(c, proofType);
  if (!marker || marker.archived || v2(marker.ontology)?.immutable !== true)
    fail("Source proof marker type unavailable");
  const input = graphChangeInput.parse({
    requestKey: `onto-proof:${await hash({ owner: owner(c), actor: c.identity.userId, key: requestKey })}`,
    preconditions: [
      ...proof.types,
      ...records,
      { type: "graph-type", id: marker.id, revision: marker.revision },
    ],
    readSets,
    operations: [
      {
        operation: "create",
        ref: "$proof",
        type: "graph-node",
        attributes: {
          id: proofId,
          typeId: proofType,
          title: "Source proof",
          body: canonical({
            version: 1,
            kind: "onto-source-proof",
            owner: owner(c),
            provider,
            proofId,
            digest,
          }),
        },
      },
    ],
  });
  await c.db.batch([
    stmt(
      "INSERT INTO onto_source_proofs(owner,id,actor,request_key,request_hash,state,proof,digest,graph_request) VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(owner,actor,request_key) DO NOTHING",
      owner(c),
      proofId,
      c.identity.userId,
      requestKey,
      requestHash,
      canonical(proof),
      digest,
      canonical(input),
    ),
  ]);
  const row = await query(
    c,
    "SELECT * FROM onto_source_proofs WHERE owner=? AND actor=? AND request_key=?",
    owner(c),
    c.identity.userId,
    requestKey,
  );
  if (!row || row.request_hash !== requestHash)
    fail("Capture key conflicts with a concurrent request");
  return finishProof(c, row);
}
async function loadProof(c: SourceContext, proofId: string) {
  const row = await query(
    c,
    "SELECT * FROM onto_source_proofs WHERE owner=? AND id=? AND state='issued'",
    owner(c),
    proofId,
  );
  if (!row) fail("Server-issued source proof unavailable", 404);
  const proof = sourceFenceProof.parse(JSON.parse(String(row.proof)));
  if (
    row.digest !== (await hash(proof)) ||
    proof.scope.owner !== owner(c) ||
    proof.scope.organizationId !== (c.identity.organizationId ?? null) ||
    proof.provider.installationId !== c.identity.installationId ||
    proof.snapshotDigest !== (await hash(proof.snapshot))
  )
    fail("Stored source proof integrity differs");
  const definition = await query(
    c,
    "SELECT digest FROM onto_source_definitions WHERE owner=? AND id=? AND version=?",
    owner(c),
    proof.selection.definitionId,
    proof.selection.definitionVersion,
  );
  if (definition?.digest !== proof.selection.definitionDigest)
    fail("Reviewed definition differs from proof");
  const input = graphChangeInput.parse(JSON.parse(String(row.graph_request)));
  checkProofRequest(proof, input, String(row.digest));
  if (
    !(await verifiedReceipt(c, String(row.actor), input, "$proof", proofType))
  )
    fail("Proof graph receipt unavailable", 503);
  return { proof, digest: String(row.digest) };
}
async function reconcile(c: SourceContext, row: Record<string, unknown>) {
  const input = graphChangeInput.parse(JSON.parse(String(row.graph_request)));
  const receipt = await verifiedReceipt(
    c,
    String(row.actor),
    input,
    "$seal",
    sealType,
  );
  if (!receipt) return null;
  const { proof, digest } = await loadProof(c, String(row.proof_id));
  const body = JSON.parse(String(input.operations[0].attributes.body));
  if (
    body.proofDigest !== digest ||
    canonical(body.subject) !== canonical(proof.subject) ||
    canonical(input.readSets) !== canonical(proof.readSets) ||
    canonical(input.preconditions?.slice(0, -1)) !==
      canonical([...proof.types, ...proof.records]) ||
    input.preconditions?.at(-1)?.id !== sealType
  )
    fail("Source seal differs from the server-issued proof");
  if (
    body.owner !== owner(c) ||
    body.provider.installationId !== c.identity.installationId ||
    body.requestHash !== row.request_hash ||
    body.proofId !== row.proof_id ||
    receipt.id !== row.receipt_id
  )
    fail("Source seal request binding differs");
  const result = {
    status: "sealed" as const,
    proofId: String(row.proof_id),
    sourceSeal: receipt,
  };
  await c.db.batch([
    stmt(
      "UPDATE onto_source_fences SET state='sealed',result=?,error=NULL WHERE owner=? AND idempotency_key=? AND request_hash=?",
      canonical(result),
      owner(c),
      row.idempotency_key,
      row.request_hash,
    ),
  ]);
  return result;
}
export async function fenceSource(
  c: SourceContext,
  provider: Provider,
  proofId: string,
  expected: Subject,
  idempotencyKey: string,
) {
  authority(c, provider);
  const requestHash = await hash({ provider, proofId, subject: expected });
  let row = await query(
    c,
    "SELECT * FROM onto_source_fences WHERE owner=? AND idempotency_key=?",
    owner(c),
    idempotencyKey,
  );
  if (row && row.request_hash !== requestHash)
    fail("Fence key already binds a different proof or subject");
  if (row) {
    const result = await reconcile(c, row);
    if (result) return result;
    if (row.state === "conflict")
      return { status: "conflict" as const, reason: String(row.error) };
  }
  const { proof, digest } = await loadProof(c, proofId);
  if (
    canonical(proof.provider) !== canonical(provider) ||
    canonical(proof.subject) !== canonical(expected)
  )
    fail("Fence subject or provider differs from captured subject");
  if (Date.now() >= proof.expiresAt) fail("Source proof expired");
  await subject(c, expected);
  const marker = await sourceType(c, sealType);
  if (!marker || marker.archived || v2(marker.ontology)?.immutable !== true)
    fail("Source seal marker unavailable");
  if (!row) {
    const receiptId = await stableGraphId(
      "onto-source-seal-v1",
      owner(c),
      c.identity.installationId,
      idempotencyKey,
    );
    const input = graphChangeInput.parse({
      requestKey: `onto-fence:${await hash({ owner: owner(c), key: idempotencyKey })}`,
      preconditions: [
        ...proof.types,
        ...proof.records,
        { type: "graph-type", id: marker.id, revision: marker.revision },
      ],
      readSets: proof.readSets,
      operations: [
        {
          operation: "create",
          ref: "$seal",
          type: "graph-node",
          attributes: {
            id: receiptId,
            typeId: sealType,
            title: "Source fence seal",
            body: canonical({
              version: 1,
              kind: "onto-source-seal",
              owner: owner(c),
              provider,
              proofId,
              proofDigest: digest,
              subject: expected,
              requestHash,
              idempotencyKey,
            }),
          },
        },
      ],
    });
    await c.db.batch([
      stmt(
        "INSERT INTO onto_source_fences(owner,idempotency_key,actor,request_hash,proof_id,graph_request,receipt_id,state) VALUES(?,?,?,?,?,?,?,'pending') ON CONFLICT(owner,idempotency_key) DO NOTHING",
        owner(c),
        idempotencyKey,
        c.identity.userId,
        requestHash,
        proofId,
        canonical(input),
        receiptId,
      ),
    ]);
    row = await query(
      c,
      "SELECT * FROM onto_source_fences WHERE owner=? AND idempotency_key=?",
      owner(c),
      idempotencyKey,
    );
  }
  if (!row || row.request_hash !== requestHash)
    fail("Fence key conflicts with a concurrent request");
  const existing = await reconcile(c, row);
  if (existing) return existing;
  if (row.actor !== c.identity.userId)
    fail("Only the initiating member may resume an uncommitted fence", 403);
  try {
    await applyGraphChanges(
      c.graph,
      c.identity,
      graphChangeInput.parse(JSON.parse(String(row.graph_request))),
    );
    const result = await reconcile(c, row);
    if (!result) fail("Source seal receipt unavailable", 503);
    return result;
  } catch (error) {
    // Never turn an uncertain write into success. Matching receipts remain reconcilable.
    const reason =
      error instanceof Response ? await error.clone().text() : String(error);
    const status =
      error instanceof Response && error.status === 409
        ? "conflict"
        : "pending";
    await c.db.batch([
      stmt(
        "UPDATE onto_source_fences SET state=?,error=? WHERE owner=? AND idempotency_key=? AND state='pending'",
        status,
        reason.slice(0, 500),
        owner(c),
        idempotencyKey,
      ),
    ]);
    return { status, reason } as {
      status: "pending" | "conflict";
      reason: string;
    };
  }
}
export async function fenceStatus(
  c: SourceContext,
  provider: Provider,
  idempotencyKey: string,
) {
  authority(c, provider);
  const row = await query(
    c,
    "SELECT * FROM onto_source_fences WHERE owner=? AND idempotency_key=?",
    owner(c),
    idempotencyKey,
  );
  if (!row) fail("Source fence request unavailable", 404);
  return (
    (await reconcile(c, row)) ?? {
      status:
        row.state === "conflict" ? ("conflict" as const) : ("pending" as const),
      reason: String(row.error ?? "Source receipt not confirmed"),
    }
  );
}
