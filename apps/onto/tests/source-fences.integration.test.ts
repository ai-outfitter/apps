import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/d1";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { sha256Hex, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import {
  readSourceSelection,
  captureSource,
  defineSource,
  fenceSource,
  fenceStatus,
  proofType,
  sealType,
  type SourceContext,
} from "../src/server/source-fences/service";
import { sourceFenceProof } from "@ai-outfitter/onto/contracts";
import { stableGraphId } from "@ai-outfitter/onto/client";
import { canonical } from "../src/lib/canonical-json";

const owner = { userId: "owner", organizationId: "org", role: "owner" },
  member = { ...owner, userId: "reader", role: "member" };
const path = "/api/internal/actions/v1/call";
async function fixture() {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "fence-installation",
  );
  const provider = {
    installationId: "fence-installation",
    contract: "outfitter.onto.source-fence" as const,
    version: 1 as const,
  };
  async function call(action: string, input: unknown, who = owner) {
    return app.call(path, who, { method: "POST", body: { action, input } });
  }
  const raw = await call("graph.apply", {
    requestKey: "setup",
    operations: [
      {
        operation: "create",
        ref: "$data",
        type: "graph-type",
        attributes: {
          category: "node",
          name: "FenceData",
          title: "Data",
          body: "Source records",
        },
      },
      {
        operation: "create",
        ref: "$empty",
        type: "graph-type",
        attributes: {
          category: "node",
          name: "FenceEmpty",
          title: "Empty",
          body: "Empty source records",
        },
      },
      {
        operation: "create",
        ref: "$immutable",
        type: "graph-type",
        attributes: {
          category: "node",
          name: "RetainedReport",
          title: "Report",
          body: "Retained subject",
          ontology: { version: 2, immutable: true },
        },
      },
      {
        operation: "create",
        ref: "$row",
        type: "graph-node",
        attributes: { typeId: "$data", title: "Source value" },
      },
      {
        operation: "create",
        ref: "$subject",
        type: "graph-node",
        attributes: {
          typeId: "$immutable",
          title: "Retained report",
          body: "Saved report",
        },
      },
    ],
  });
  assert.equal(raw.status, 200, await raw.clone().text());
  const seeded = (await raw.json()) as Record<
    string,
    { id: string; revision: number }
  >;
  const subjectRecord = await app.call("/api/internal/entities/v1/get", owner, {
    method: "POST",
    body: { type: "graph-node", id: seeded.$subject.id },
  });
  const record = (await subjectRecord.json()) as {
    attributes: Record<string, unknown>;
  };
  const subject = {
    installationId: provider.installationId,
    type: "graph-node" as const,
    id: seeded.$subject.id,
    revision: 1,
    digest: await sha256Hex(canonicalActionValue(record.attributes)),
  };
  const definition = {
    version: 1 as const,
    selection: "whole-owner-type-membership-v1" as const,
    sets: [
      {
        type: "graph-node" as const,
        typeId: seeded.$data.id,
        includeArchived: false,
      },
      {
        type: "graph-node" as const,
        typeId: seeded.$empty.id,
        includeArchived: false,
      },
    ],
    records: [],
  };
  const defined = await call("source.define", {
    provider,
    id: "lens",
    version: 1,
    definition,
  });
  assert.equal(defined.status, 200, await defined.clone().text());
  const captureInput = {
    provider,
    definitionId: "lens",
    definitionVersion: 1,
    requestKey: "capture",
    subject,
  };
  const capture = async () => {
    const response = await call("source.capture", captureInput);
    assert.equal(response.status, 200, await response.clone().text());
    return sourceFenceProof.parse(await response.json());
  };
  const db: AgentDatabase = {
    query: async (s) =>
      (
        await app.database
          .prepare(s.sql)
          .bind(...(s.params ?? []))
          .all<Record<string, unknown>>()
      ).results,
    batch: async (ss) =>
      app.database.batch(
        ss.map((s) => app.database.prepare(s.sql).bind(...(s.params ?? []))),
      ),
  };
  const identity: AppIdentity = {
    ...owner,
    owner: { kind: "organization", id: "org" },
    installationId: provider.installationId,
    canEdit: true,
  };
  const context: SourceContext = { db, graph: drizzle(app.database), identity };
  return {
    app,
    provider,
    seeded,
    subject,
    definition,
    call,
    capture,
    captureInput,
    db,
    context,
  };
}

test("source-local issuance preserves empty sets and seals the exact immutable entity subject", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proof = await f.capture();
  assert.deepEqual(
    proof.readSets.find((set) => set.typeId === f.seeded.$empty.id)?.records,
    [],
  );
  assert.equal(proof.subject.digest, f.subject.digest);
  assert.equal(proof.completeness.complete, true);
  const input = {
    provider: f.provider,
    proofId: proof.id,
    subject: f.subject,
    idempotencyKey: "seal",
  };
  const response = await f.call("source.fence", input);
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    status: string;
    sourceSeal: { id: string; digest: string };
  };
  assert.equal(result.status, "sealed");
  assert.match(result.sourceSeal.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await (await f.call("source.fence", input)).json(), result);
  const changed = await f.call("source.fence", {
    ...input,
    subject: { ...f.subject, digest: "0".repeat(64) },
  });
  assert.equal(changed.status, 409);
  assert.deepEqual(
    await f.capture(),
    proof,
    "capture replay retains its original instant and evidence",
  );
});

for (const change of ["empty-add", "remove", "revision", "type"] as const)
  test(`source-local seal rejects changed ${change}`, async (t) => {
    const f = await fixture();
    t.after(() => f.app.dispose());
    const proof = await f.capture();
    const operation =
      change === "empty-add"
        ? {
            operation: "create",
            ref: "$added",
            type: "graph-node",
            attributes: {
              typeId: f.seeded.$empty.id,
              title: "Inserted into empty set",
            },
          }
        : change === "type"
          ? {
              operation: "update",
              ref: "$type",
              type: "graph-type",
              id: f.seeded.$data.id,
              revision: 1,
              attributes: { title: "Changed source semantics" },
            }
          : {
              operation: "update",
              ref: "$row",
              type: "graph-node",
              id: f.seeded.$row.id,
              revision: 1,
              attributes:
                change === "remove" ? { archived: true } : { title: "Changed" },
            };
    const update = await f.call("graph.apply", {
      requestKey: `change-${change}`,
      operations: [operation],
    });
    assert.equal(update.status, 200, await update.clone().text());
    const result = await f.call("source.fence", {
      provider: f.provider,
      proofId: proof.id,
      subject: f.subject,
      idempotencyKey: "seal",
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(
      ((await result.json()) as { status: string }).status,
      "conflict",
    );
  });

test("caller proofs, forged graph markers, foreign bindings and revoked editor authority do not authorize a fence", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proof = await f.capture();
  assert.equal(
    (
      await f.call("source.capture", {
        ...f.captureInput,
        completeness: { complete: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("source.capture", {
        ...f.captureInput,
        provider: { ...f.provider, installationId: "other" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("source.capture", f.captureInput, member)).status,
    403,
  );
  assert.equal(
    (
      await f.call("source.define", {
        provider: f.provider,
        id: "lens",
        version: 1,
        definition: { ...f.definition, sets: [] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("source.define", {
        provider: f.provider,
        id: "lens",
        version: 1,
        definition: { ...f.definition, sets: [f.definition.sets[0]] },
      })
    ).status,
    409,
  );
  const forgedId = crypto.randomUUID();
  const forged = await f.call("graph.apply", {
    requestKey: "forged-proof-marker",
    operations: [
      {
        operation: "create",
        ref: "$forged",
        type: "graph-node",
        attributes: {
          id: forgedId,
          typeId: proofType,
          title: "Forged proof",
          body: canonical({
            version: 1,
            kind: "onto-source-proof",
            owner: "organization:org",
            provider: f.provider,
            proofId: forgedId,
            digest: await sha256Hex(canonical(proof)),
          }),
        },
      },
    ],
  });
  assert.equal(forged.status, 200, await forged.clone().text());
  const missing = await f.call("source.fence", {
    provider: f.provider,
    proofId: forgedId,
    subject: f.subject,
    idempotencyKey: "forged",
  });
  assert.equal(missing.status, 404);
  const fakeSealId = await stableGraphId(
    "onto-source-seal-v1",
    "organization:org",
    f.provider.installationId,
    "fake-seal",
  );
  const requestHash = await sha256Hex(
    canonical({ provider: f.provider, proofId: proof.id, subject: f.subject }),
  );
  const fakeSeal = await f.call("graph.apply", {
    requestKey: "forged-seal-marker",
    operations: [
      {
        operation: "create",
        ref: "$forged",
        type: "graph-node",
        attributes: {
          id: fakeSealId,
          typeId: sealType,
          title: "Source fence seal",
          body: canonical({
            version: 1,
            kind: "onto-source-seal",
            owner: "organization:org",
            provider: f.provider,
            proofId: proof.id,
            proofDigest: await sha256Hex(canonical(proof)),
            subject: f.subject,
            requestHash,
            idempotencyKey: "fake-seal",
          }),
        },
      },
    ],
  });
  assert.equal(fakeSeal.status, 200, await fakeSeal.clone().text());
  const rejected = await f.call("source.fence", {
    provider: f.provider,
    proofId: proof.id,
    subject: f.subject,
    idempotencyKey: "fake-seal",
  });
  assert.equal(rejected.status, 200, await rejected.clone().text());
  assert.equal(
    ((await rejected.json()) as { status: string }).status,
    "conflict",
    "a matching seal body without the server graph.apply receipt is not authority",
  );
  assert.equal(
    (
      await f.call(
        "source.fence",
        {
          provider: f.provider,
          proofId: proof.id,
          subject: f.subject,
          idempotencyKey: "seal",
        },
        member,
      )
    ).status,
    403,
  );
  await assert.rejects(
    fenceSource(
      {
        ...f.context,
        identity: {
          ...f.context.identity,
          owner: { kind: "organization", id: "other" },
          organizationId: "other",
        },
      },
      f.provider,
      proof.id,
      f.subject,
      "seal",
    ),
    (error) => error instanceof Response && error.status === 404,
  );
  await assert.rejects(
    captureSource(f.context, f.provider, "lens", 1, "wrong-digest", {
      ...f.subject,
      digest: "0".repeat(64),
    }),
    (error) => error instanceof Response && error.status === 409,
  );
});

test("concurrent identical fences converge and pending acknowledgement recovers from its exact graph receipt", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proof = await f.capture();
  let crash = true;
  const broken: SourceContext = {
    ...f.context,
    db: {
      ...f.db,
      batch: async (statements) => {
        if (
          crash &&
          statements.some((s) =>
            s.sql.startsWith("UPDATE onto_source_fences SET state='sealed'"),
          )
        ) {
          crash = false;
          throw new Error("simulated crash after graph commit");
        }
        return f.db.batch(statements);
      },
    },
  };
  const interrupted = await fenceSource(
    broken,
    f.provider,
    proof.id,
    f.subject,
    "crash",
  );
  assert.equal(interrupted.status, "pending");
  const recovered = await fenceStatus(f.context, f.provider, "crash");
  assert.equal(recovered.status, "sealed");
  assert.deepEqual(
    await fenceSource(f.context, f.provider, proof.id, f.subject, "crash"),
    recovered,
  );
  const results = await Promise.all([
    fenceSource(f.context, f.provider, proof.id, f.subject, "concurrent"),
    fenceSource(f.context, f.provider, proof.id, f.subject, "concurrent"),
  ]);
  assert.equal(results[0].status, "sealed");
  assert.deepEqual(results[0], results[1]);
});

test("expiry and private proof corruption fail closed", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proof = await f.capture();
  const clock = Date.now;
  try {
    Date.now = () => proof.expiresAt + 1;
    await assert.rejects(
      fenceSource(f.context, f.provider, proof.id, f.subject, "expired"),
      (error) => error instanceof Response && error.status === 409,
    );
  } finally {
    Date.now = clock;
  }
  // Corruption cannot turn a caller-supplied completeness flag or edited read set into authority.
  await f.db.batch([
    {
      sql: "UPDATE onto_source_proofs SET proof=json_set(proof,'$.readSets[0].records',json('[]')) WHERE id=?",
      params: [proof.id],
    },
  ]);
  await assert.rejects(
    fenceSource(f.context, f.provider, proof.id, f.subject, "corrupt"),
    (error) => error instanceof Response && error.status === 409,
  );
});

test("personal-owner captures do not invent an organization scope", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const context = {
    ...f.context,
    identity: {
      ...f.context.identity,
      owner: { kind: "user" as const, id: "owner" },
      organizationId: undefined,
    },
  };
  await defineSource(context, f.provider, "personal", 1, f.definition);
  const proof = await captureSource(
    context,
    f.provider,
    "personal",
    1,
    "personal",
    f.subject,
  );
  assert.equal(proof.scope.owner, "user:owner");
  assert.equal(proof.scope.organizationId, null);
  assert.equal(
    (await fenceSource(context, f.provider, proof.id, f.subject, "personal"))
      .status,
    "sealed",
  );
});

test("proof issuance acknowledgement is recoverable and changed concurrent keys conflict", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  let crash = true;
  const broken = {
    ...f.context,
    db: {
      ...f.db,
      batch: async (statements: Parameters<AgentDatabase["batch"]>[0]) => {
        if (
          crash &&
          statements.some((s) =>
            s.sql.startsWith("UPDATE onto_source_proofs SET state='issued'"),
          )
        ) {
          crash = false;
          throw new Error("lost proof acknowledgement");
        }
        return f.db.batch(statements);
      },
    },
  };
  await assert.rejects(
    captureSource(broken, f.provider, "lens", 1, "recover-proof", f.subject),
  );
  const proof = await captureSource(
    f.context,
    f.provider,
    "lens",
    1,
    "recover-proof",
    f.subject,
  );
  const other = await captureSource(
    f.context,
    f.provider,
    "lens",
    1,
    "other-proof",
    f.subject,
  );
  const results = await Promise.allSettled([
    fenceSource(f.context, f.provider, proof.id, f.subject, "shared-key"),
    fenceSource(f.context, f.provider, other.id, f.subject, "shared-key"),
  ]);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "fulfilled" && result.value.status === "sealed",
    ).length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Response &&
        result.reason.status === 409,
    ).length,
    1,
  );
});

test("membership overflow is refused before a complete proof is issued", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await f.db.batch([
    {
      sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2001) INSERT INTO graph_nodes(id,typeId,slug,title,createdAt,updatedAt) SELECT printf('00000000-0000-4000-8000-%012d',x),?,printf('bounded-%d',x),'Bounded record',1,1 FROM n",
      params: [f.seeded.$empty.id],
    },
  ]);
  await assert.rejects(
    captureSource(f.context, f.provider, "lens", 1, "too-many", f.subject),
    (error) => error instanceof Response && error.status === 413,
  );
  const rows = await f.db.query({
    sql: "SELECT id FROM onto_source_proofs",
    params: [],
  });
  assert.equal(rows.length, 0);
});

test("additional evidence revisions and archived edge membership remain fenced", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const raw = await f.call("graph.apply", {
    requestKey: "edge-source",
    operations: [
      {
        operation: "create",
        ref: "$type",
        type: "graph-type",
        attributes: {
          category: "edge",
          name: "FenceRelationship",
          title: "Relationship",
          body: "Bounded relationship source",
        },
      },
      {
        operation: "create",
        ref: "$edge",
        type: "graph-edge",
        attributes: {
          typeId: "$type",
          fromId: f.seeded.$row.id,
          toId: f.subject.id,
        },
      },
    ],
  });
  assert.equal(raw.status, 200, await raw.clone().text());
  const edge = (await raw.json()) as Record<
    string,
    { id: string; revision: number }
  >;
  const definition = {
    ...f.definition,
    sets: [
      {
        type: "graph-edge" as const,
        typeId: edge.$type.id,
        includeArchived: true,
      },
    ],
    records: [{ type: "graph-node" as const, id: f.seeded.$row.id }],
  };
  await defineSource(f.context, f.provider, "edges", 1, definition);
  const first = await captureSource(
    f.context,
    f.provider,
    "edges",
    1,
    "edge-proof",
    f.subject,
  );
  assert.equal(first.readSets[0].includeArchived, true);
  assert.equal(first.readSets[0].records[0].id, edge.$edge.id);
  const archive = await f.call("graph.apply", {
    requestKey: "archive-edge",
    operations: [
      {
        operation: "update",
        ref: "$edge",
        type: "graph-edge",
        id: edge.$edge.id,
        revision: 1,
        attributes: { archived: true },
      },
    ],
  });
  assert.equal(archive.status, 200, await archive.clone().text());
  assert.equal(
    (
      await fenceSource(
        f.context,
        f.provider,
        first.id,
        f.subject,
        "edge-change",
      )
    ).status,
    "conflict",
  );
  const second = await captureSource(
    f.context,
    f.provider,
    "edges",
    1,
    "record-proof",
    f.subject,
  );
  assert.equal(
    second.readSets[0].records.length,
    1,
    "archived edges remain in an explicitly inclusive set",
  );
  const updated = await f.call("graph.apply", {
    requestKey: "additional-record-change",
    operations: [
      {
        operation: "update",
        ref: "$record",
        type: "graph-node",
        id: f.seeded.$row.id,
        revision: 1,
        attributes: { title: "Changed extra evidence" },
      },
    ],
  });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal(
    (
      await fenceSource(
        f.context,
        f.provider,
        second.id,
        f.subject,
        "record-change",
      )
    ).status,
    "conflict",
  );
});

test("snapshot byte overflow never issues a partial proof", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await f.db.batch([
    {
      sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9) INSERT INTO graph_nodes(id,typeId,slug,title,body,createdAt,updatedAt) SELECT printf('00000000-0000-4000-8001-%012d',x),?,printf('large-%d',x),'Large retained source',hex(zeroblob(32500)),1,1 FROM n",
      params: [f.seeded.$empty.id],
    },
  ]);
  await assert.rejects(
    captureSource(f.context, f.provider, "lens", 1, "too-large", f.subject),
    (error) => error instanceof Response && error.status === 413,
  );
  assert.equal(
    (await f.db.query({ sql: "SELECT id FROM onto_source_proofs", params: [] }))
      .length,
    0,
  );
});

test("capture reads only bounded selected types and retains explicit evidence", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await f.app.database
    .prepare(
      "UPDATE graph_nodes SET privateData=?, externalProvider=?, externalId='private-' || id WHERE id IN (?,?)",
    )
    .bind(
      JSON.stringify({ connectorSecret: "connector-private-value" }),
      "private-connector",
      f.seeded.$row.id,
      f.subject.id,
    )
    .run();
  const queries: { sql: string; params: unknown[] }[] = [];
  const graph = drizzle(f.app.database, {
    logger: {
      logQuery(sql, params) {
        queries.push({ sql, params });
      },
    },
  });
  const selection = await readSourceSelection(
    { ...f.context, graph },
    {
      ...f.definition,
      sets: [f.definition.sets[1]],
      records: [{ type: "graph-node", id: f.seeded.$row.id }],
    },
    f.subject,
  );
  assert.equal(selection.readSets[0].records.length, 0);
  assert.equal(selection.snapshot.nodes.length, 1);
  assert.equal(selection.snapshot.nodes[0].id, f.seeded.$row.id);
  assert.equal(selection.snapshot.nodes[0].title, "Source value");
  for (const record of [
    selection.snapshot.nodes[0],
    selection.snapshot.subject.attributes,
  ]) {
    assert.equal(Object.hasOwn(record, "privateData"), false);
    assert.equal(Object.hasOwn(record, "externalProvider"), false);
    assert.equal(Object.hasOwn(record, "externalId"), false);
  }
  assert.doesNotMatch(JSON.stringify(selection.snapshot), /connector-private-value/);
  const reads = queries.filter((q) =>
    /from "graph_(nodes|edges|types)"/.test(q.sql),
  );
  assert.ok(reads.length >= 4);
  for (const q of reads) {
    assert.match(q.sql, /where /i);
    if (!q.sql.includes('"id" = ?')) {
      assert.match(q.sql, /limit /i);
      assert.ok(q.params.includes(1) || q.params.includes(2001), q.sql);
    }
  }
  const membership = reads.filter((q) => q.sql.includes('"typeId" ='));
  assert.equal(membership.length, 1);
  assert.ok(membership[0].params.includes(f.seeded.$empty.id));
  assert.ok(membership[0].params.includes(2001));
});

test("portable archive imports cannot author source definitions, proofs or fences", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const proof = await f.capture();
  assert.equal(
    (
      await fenceSource(
        f.context,
        f.provider,
        proof.id,
        f.subject,
        "archive-seal",
      )
    ).status,
    "sealed",
  );
  const names = [
    "onto_source_definitions",
    "onto_source_proofs",
    "onto_source_fences",
  ];
  const before = await Promise.all(
    names.map((table) =>
      f.db.query({ sql: `SELECT * FROM ${table}`, params: [] }),
    ),
  );
  const tables: Record<
    string,
    { key: string[]; columns: string[]; rows: unknown[][] }
  > = {};
  let cursor: string | null = null;
  let template: Record<string, unknown> = {};
  do {
    const response = await f.app.call(
      `/api/outfitter/data/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      owner,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const archive = (await response.json()) as {
      tables: typeof tables;
      cursor: string | null;
    };
    template = archive;
    for (const name of names)
      if (archive.tables[name]) {
        const table = archive.tables[name];
        const copy = structuredClone(table);
        // Attempt both replacing trusted rows and populating fresh authority keys.
        const column = copy.columns.indexOf(
          name === "onto_source_fences" ? "proof_id" : "digest",
        );
        assert.ok(column >= 0);
        for (const row of copy.rows)
          row[column] =
            name === "onto_source_fences"
              ? crypto.randomUUID()
              : "f".repeat(64);
        const fresh = structuredClone(copy.rows);
        for (const row of fresh) {
          row[
            copy.columns.indexOf(
              name === "onto_source_fences" ? "idempotency_key" : "id",
            )
          ] = crypto.randomUUID();
          if (name === "onto_source_proofs")
            row[copy.columns.indexOf("request_key")] = crypto.randomUUID();
        }
        copy.rows.push(...fresh);
        tables[name] = copy;
      }
    cursor = archive.cursor;
  } while (cursor);
  assert.deepEqual(
    Object.keys(tables).sort(),
    names.toSorted(),
    "backups retain private rows for disaster recovery",
  );
  const archive = { ...template, tables, cursor: null };
  const preview = await f.app.call("/api/outfitter/data/preview", owner, {
    method: "POST",
    body: { archive, map: {} },
  });
  assert.equal(preview.status, 200, await preview.clone().text());
  const { previewToken } = (await preview.json()) as { previewToken: string };
  const imported = await f.app.call("/api/outfitter/data/import", owner, {
    method: "POST",
    body: { archive, map: {}, previewToken },
  });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.deepEqual(
    await Promise.all(
      names.map((table) =>
        f.db.query({ sql: `SELECT * FROM ${table}`, params: [] }),
      ),
    ),
    before,
  );
});
