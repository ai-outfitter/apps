import assert from "node:assert/strict";
import test from "node:test";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { drizzle } from "drizzle-orm/d1";
import { core } from "../src/lib/graph";
import { auditOntology, auditProposal } from "../src/lib/ontology-validation";
import { readGraph } from "../src/server/graph";
import {
  applyGraphChanges,
  graphChangeInput,
} from "../src/server/graph-changes";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { userId: "member", organizationId: "org", role: "member" };
const path = "/api/internal/actions/v1/";
const entityPath = "/api/internal/entities/v1/";
const artifact = () =>
  appArtifact(new URL("..", import.meta.url), "operational");
const create = (ref: string, type: string, attributes: object) => ({
  operation: "create",
  ref,
  type,
  attributes,
});
const sample = () => [
  create("$edge", "graph-edge", {
    typeId: "$relation",
    fromId: "$keystone",
    toId: "$other",
  }),
  create("$keystone", "graph-node", {
    typeId: "$type",
    title: "Keystone",
    slug: "batch-keystone",
  }),
  create("$other", "graph-node", {
    typeId: "$type",
    title: "Other",
    slug: "batch-other",
  }),
  create("$type", "graph-type", {
    category: "node",
    name: "BatchEntity",
    title: "Batch entity",
    body: "Synthetic batch type.",
  }),
  create("$relation", "graph-type", {
    category: "edge",
    name: "BatchRelation",
    title: "Batch relation",
    body: "Synthetic batch relationship.",
  }),
];
// biome-ignore lint/suspicious/noExplicitAny: public JSON contract under test.
async function json(response: Response): Promise<any> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function fixture() {
  const app = await appWorker("wiki-map", artifact());
  return {
    app,
    apply: (requestKey: string, operations: object[], identity: typeof owner & { entityWriter?: string } = owner) =>
      app.call(path + "call", identity, {
        method: "POST",
        body: { action: "graph.apply", input: { requestKey, operations } },
      }),
    get: async (type: string, id: string) =>
      json(
        await app.call(entityPath + "get", owner, {
          method: "POST",
          body: { type, id },
        }),
      ),
  };
}

test("one batch creates unordered type/node/edge dependencies and retries return original receipts", async () => {
  const f = await fixture();
  try {
    const input = sample().map((op) => ({
      ...op,
      attributes: { ...op.attributes, id: crypto.randomUUID() },
    }));
    const [first, concurrent] = await Promise.all([
      f.apply("same", input).then(json),
      f.apply("same", input).then(json),
    ]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(
      Object.keys(first).sort(),
      ["$edge", "$keystone", "$other", "$relation", "$type"].sort(),
    );
    assert.deepEqual(Object.keys(first.$keystone).sort(), ["id", "revision"]);
    assert.equal((await f.apply("same", input, member)).status, 403);
    assert.equal(
      (await f.apply("same", input, { ...owner, userId: "other-owner" }))
        .status,
      409,
    );
    const node = await f.get("graph-node", first.$keystone.id);
    const edge = await f.get("graph-edge", first.$edge.id);
    assert.equal(node.attributes.typeId, first.$type.id);
    assert.equal(edge.attributes.fromId, first.$keystone.id);
    assert.equal(edge.attributes.toId, first.$other.id);
    assert.equal(node.attributes.provenance.createdBy, owner.userId);
    const update = [
      {
        operation: "update",
        ref: "$node",
        type: "graph-node",
        id: first.$keystone.id,
        revision: 1,
        attributes: { title: "Keystone updated" },
      },
    ];
    const updated = await json(await f.apply("update", update));
    assert.deepEqual(updated.$node, { id: first.$keystone.id, revision: 2 });
    assert.equal(
      (await f.get("graph-node", first.$keystone.id)).attributes.slug,
      "batch-keystone",
    );
    assert.deepEqual(await json(await f.apply("same", input)), first);
    assert.equal((await f.get("graph-node", first.$keystone.id)).revision, 2);
    assert.equal((await f.apply("update", sample())).status, 409);
    assert.equal((await f.apply("stale", update)).status, 409);
    // Equivalent JSON with reordered attribute keys has the same request identity.
    const reordered = input.map((op) => ({
      ...op,
      attributes: Object.fromEntries(Object.entries(op.attributes).reverse()),
    }));
    assert.deepEqual(await json(await f.apply("same", reordered)), first);
  } finally {
    await f.app.dispose();
  }
});

test("a late SQL uniqueness conflict rolls back types, nodes and the retry receipt", async () => {
  const f = await fixture();
  try {
    const tables = [
      "graph_types",
      "graph_nodes",
      "graph_edges",
      "graph_changes",
    ];
    const count = async (table: string) =>
      (
        await f.app.database
          .prepare(`SELECT count(*) AS count FROM ${table}`)
          .first<{ count: number }>()
      )?.count;
    const before = await Promise.all(tables.map(count));
    const operations = sample();
    operations.push(
      create("$duplicate", "graph-edge", {
        typeId: "$relation",
        fromId: "$keystone",
        toId: "$other",
      }),
    );
    assert.equal((await f.apply("rollback", operations)).status, 409);
    assert.deepEqual(await Promise.all(tables.map(count)), before);
    // Failure did not reserve the key: corrected changes can use it.
    assert.ok((await json(await f.apply("rollback", sample()))).$edge.id);
  } finally {
    await f.app.dispose();
  }
});

test("invalid dependencies, canonical records and incompatible type changes fail without writes", async () => {
  const f = await fixture();
  try {
    const bad = [
      [create("$node", "graph-node", { typeId: "$missing", title: "Unknown" })],
      [
        create("$node", "graph-node", {
          id: "invalid",
          typeId: core.entity,
          title: "Invalid ID",
        }),
      ],
      [
        create("$node", "graph-node", {
          typeId: core.entity,
          title: "Source",
          source: {},
        }),
      ],
      [
        create("$one", "graph-node", { typeId: core.entity, title: "One" }),
        create("$one", "graph-node", {
          typeId: core.entity,
          title: "Duplicate",
        }),
      ],
      [
        create("$node", "graph-node", { typeId: core.entity, title: "Self" }),
        create("$edge", "graph-edge", {
          typeId: core.uses,
          fromId: "$node",
          toId: "$node",
        }),
      ],
      [
        create("$node", "graph-node", {
          typeId: core.entity,
          title: "Bad properties",
          properties: { unknown: true },
        }),
      ],
    ];
    for (const [index, operations] of bad.entries())
      assert.equal((await f.apply(`invalid-${index}`, operations)).status, 400);
    assert.equal(
      (
        await f.app.database
          .prepare("SELECT count(*) AS count FROM graph_changes")
          .first<{ count: number }>()
      )?.count,
      0,
    );
    const saved = await json(await f.apply("valid", sample()));
    const response = await f.apply("bad-type", [
      {
        operation: "update",
        ref: "$type",
        type: "graph-type",
        id: saved.$type.id,
        revision: 1,
        attributes: { category: "edge" },
      },
    ]);
    assert.equal(response.status, 400);
    assert.equal((await f.get("graph-type", saved.$type.id)).revision, 1);
  } finally {
    await f.app.dispose();
  }
});

test("batch discovery and invocation preserve editor authority and input bounds", async () => {
  const f = await fixture();
  try {
    const actions = await json(await f.app.call(path + "list", member));
    const apply = actions.find(
      (action: { name: string }) => action.name === "graph.apply",
    );
    assert.equal(apply.permitted, false);
    assert.equal((await f.apply("member", sample(), member)).status, 403);
    assert.equal(
      (
        await f.app.call(path + "call", undefined, {
          method: "POST",
          body: {
            action: "graph.apply",
            input: { requestKey: "anonymous", operations: sample() },
          },
        })
      ).status,
      401,
    );
    assert.equal((await f.apply("empty", [])).status, 400);
    assert.equal(
      (
        await f.apply(
          "over-limit",
          Array.from({ length: 101 }, (_, i) =>
            create(`$n${i}`, "graph-node", {
              typeId: core.entity,
              title: "Bounded",
            }),
          ),
        )
      ).status,
      400,
    );
  } finally {
    await f.app.dispose();
  }
});

test("a graph mutation between validation and commit refuses the whole batch", async () => {
  const f = await fixture();
  try {
    const client = f.app.database;
    const original = client.batch.bind(client);
    const intercepted = {
      prepare: client.prepare.bind(client),
      batch: async (...args: Parameters<typeof original>) => {
        await client
          .prepare("UPDATE graph_types SET revision=revision+1 WHERE id=?")
          .bind(core.entity)
          .run();
        return original(...args);
      },
    };
    const db = drizzle(intercepted as unknown as Parameters<typeof drizzle>[0]);
    const who: AppIdentity = {
      ...owner,
      installationId: f.app.installationId,
      owner: { kind: "organization", id: "org" },
      canEdit: true,
    };
    await assert.rejects(
      applyGraphChanges(
        db,
        who,
        graphChangeInput.parse({ requestKey: "raced", operations: sample() }),
      ),
      (error: unknown) => error instanceof Response && error.status === 409,
    );
    assert.equal(
      (
        await client
          .prepare("SELECT count(*) AS count FROM graph_changes")
          .first<{ count: number }>()
      )?.count,
      0,
    );
    assert.equal(
      (
        await client
          .prepare(
            "SELECT count(*) AS count FROM graph_nodes WHERE slug='batch-keystone'",
          )
          .first<{ count: number }>()
      )?.count,
      0,
    );
  } finally {
    await f.app.dispose();
  }
});

test("unrelated legacy data does not block batches; updated types still validate affected records", async () => {
  const f = await fixture();
  try {
    const saved = await json(await f.apply("initial", sample()));
    await f.app.database
      .prepare("UPDATE graph_nodes SET properties='{}' WHERE id=?")
      .bind(saved.$keystone.id)
      .run();
    const schemaUpdate = [
      {
        operation: "update",
        ref: "$type",
        type: "graph-type",
        id: saved.$type.id,
        revision: 1,
        attributes: {
          properties: [
            {
              name: "required",
              type: "string",
              description: "Required field",
              required: true,
            },
          ],
        },
      },
    ];
    assert.equal((await f.apply("required", schemaUpdate)).status, 400);
    await f.app.database
      .prepare("UPDATE graph_nodes SET properties=? WHERE id=?")
      .bind(JSON.stringify({ legacy_unknown: true }), saved.$keystone.id)
      .run();
    const next = await json(
      await f.apply("unrelated", [
        create("$auto", "graph-node", {
          typeId: core.entity,
          title: "Reserved",
        }),
        create("$explicit", "graph-node", {
          typeId: core.entity,
          title: "Explicit",
          slug: "reserved",
        }),
      ]),
    );
    assert.notEqual(
      (await f.get("graph-node", next.$auto.id)).attributes.slug,
      "reserved",
    );
    assert.equal(
      (await f.get("graph-node", next.$explicit.id)).attributes.slug,
      "reserved",
    );
  } finally {
    await f.app.dispose();
  }
});

test("the 4-type, 30-node, 38-edge workload fits one bounded action call", async (t) => {
  const f = await fixture();
  try {
    const types = Array.from({ length: 4 }, (_, i) =>
      create(`$t${i}`, "graph-type", {
        category: i < 2 ? "node" : "edge",
        name: `WorkloadType${i}`,
        title: `Workload type ${i}`,
        body: "Synthetic workload type.",
      }),
    );
    const nodes = Array.from({ length: 30 }, (_, i) =>
      create(`$n${i}`, "graph-node", {
        typeId: `$t${i % 2}`,
        title: `Workload node ${i}`,
        slug: `workload-${i}`,
      }),
    );
    const edges = Array.from({ length: 38 }, (_, i) =>
      create(`$e${i}`, "graph-edge", {
        typeId: `$t${2 + Math.floor(i / 30)}`,
        fromId: `$n${i % 30}`,
        toId: `$n${(i + 1) % 30}`,
      }),
    );
    const response = await f.apply("workload", [...edges, ...nodes, ...types]);
    assert.equal(response.status, 200, await response.clone().text());
    const bytes = await response.text();
    const receipt = JSON.parse(bytes);
    assert.equal(Object.keys(receipt).length, 72);
    assert.equal(
      (await f.get("graph-node", receipt.$n0.id)).attributes.typeId,
      receipt.$t0.id,
    );
    assert.equal(
      (await f.get("graph-edge", receipt.$e37.id)).attributes.fromId,
      receipt.$n7.id,
    );
    t.diagnostic(
      `72 operations in one Worker action call; receipt ${Buffer.byteLength(bytes)} bytes.`,
    );
  } finally {
    await f.app.dispose();
  }
});

test("ontology endpoint rules are shared by batch and entity writes", async () => {
  const f = await fixture();
  try {
    const person = crypto.randomUUID(),
      product = crypto.randomUUID(),
      relation = crypto.randomUUID();
    const operations = [
      create("$personType", "graph-type", {
        id: person,
        category: "node",
        name: "TestPerson",
        title: "Person",
        body: "Person.",
      }),
      create("$productType", "graph-type", {
        id: product,
        category: "node",
        name: "TestProduct",
        title: "Product",
        body: "Product.",
      }),
      create("$relation", "graph-type", {
        id: relation,
        category: "edge",
        name: "TestUses",
        title: "uses",
        body: "Uses.",
        ontology: { version: 1, endpoints: { from: [person], to: [product] } },
      }),
      create("$person", "graph-node", {
        typeId: person,
        title: "Person",
        slug: "test-person",
      }),
      create("$product", "graph-node", {
        typeId: product,
        title: "Product",
        slug: "test-product",
      }),
    ];
    const receipt = await json(await f.apply("ontology-create", operations));
    const attrs = {
      typeId: relation,
      fromId: receipt.$product.id,
      toId: receipt.$person.id,
    };
    const bad = await f.apply("ontology-invalid", [
      create("$bad", "graph-edge", attrs),
    ]);
    assert.equal(bad.status, 400);
    const error = (await bad.json()) as {
      code: string;
      errors: { operationRefs: string[] }[];
    };
    assert.equal(error.code, "ontology_validation_failed");
    assert.deepEqual(error.errors[0].operationRefs, ["$bad"]);
    const direct = await f.app.call(entityPath + "create", owner, {
      method: "POST",
      body: { type: "graph-edge", attributes: attrs },
    });
    assert.equal(direct.status, 400);
    assert.equal((await direct.json() as { code: string }).code, "ontology_validation_failed");
    const good = await json(
      await f.apply("ontology-valid", [
        create("$good", "graph-edge", {
          ...attrs,
          fromId: receipt.$person.id,
          toId: receipt.$product.id,
        }),
      ]),
    );
    const archive = await f.apply("ontology-archive", [
      {
        operation: "update",
        ref: "$person",
        type: "graph-node",
        id: receipt.$person.id,
        revision: 1,
        attributes: { archived: true },
      },
    ]);
    assert.equal(archive.status, 400);
    const directArchive = await f.app.call(entityPath + "update", owner, {
      method: "POST", body: { type: "graph-node", id: receipt.$person.id, revision: 1, attributes: { archived: true } },
    });
    assert.equal(directArchive.status, 400);
    assert.equal((await directArchive.json() as { code: string }).code, "ontology_validation_failed");
    assert.equal(
      (await f.get("graph-edge", good.$good.id)).attributes.archived,
      false,
    );
    // The Wiki assistant's ontology.audit, over the stored graph and over a proposed contract.
    const graph = await readGraph(drizzle(f.app.database), {} as never);
    assert.deepEqual(auditOntology(graph), []);
    const violations = auditProposal(graph, { typeId: relation, ontology: { version: 1, endpoints: { from: [product], to: [person] } } });
    assert.equal(violations.length, 2);
    assert.equal(
      (await f.get("graph-type", relation)).attributes.ontology.endpoints
        .from[0],
      person,
    );
  } finally {
    await f.app.dispose();
  }
});

test("external projects and organization relationships persist without Planning through graph.apply", async () => {
  const f = await fixture();
  try {
    const receipt = await json(await f.apply("external-project", [
      create("$organization", "graph-node", { typeId: core.organization, title: "Example client" }),
      create("$project", "graph-node", { typeId: core.project, title: "Recommendations" }),
      create("$ownership", "graph-edge", { typeId: "71000000-0000-4000-8000-000000000032", fromId: "$project", toId: "$organization" }),
    ]));
    const project = await f.get("graph-node", receipt.$project.id);
    assert.deepEqual(project.references, []);
    assert.equal(project.attributes.title, "Recommendations");
    const ownership = await f.get("graph-edge", receipt.$ownership.id);
    assert.equal(ownership.attributes.fromId, project.ref.id);
    assert.equal(ownership.attributes.toId, receipt.$organization.id);
    await json(await f.apply("external-update", [{ operation: "update", ref: "$project", type: "graph-node", id: project.ref.id, revision: project.revision, attributes: { summary: "Client work" } }]));
    assert.equal((await f.get("graph-node", project.ref.id)).attributes.summary, "Client work");
    const canonical = await json(await f.app.call(entityPath + "create", owner, {
      method: "POST", body: { type: "graph-node", attributes: { typeId: core.project, title: "Managed work" }, references: [{ installationId: "planning", type: "project", id: "managed" }] },
    }));
    assert.equal((await f.apply("canonical-update", [{ operation: "update", ref: "$managed", type: "graph-node", id: canonical.ref.id, revision: canonical.revision, attributes: { summary: "Attempted bypass" } }])).status, 400);

  } finally {
    await f.app.dispose();
  }
});

test("read preconditions reject stale endpoints atomically and replay committed receipts", async () => {
  const f = await fixture();
  try {
    const seeded = await json(await f.apply("precondition-seed", sample()));
    const requestKey = "precondition-save";
    const operations = [{ operation: "update", ref: "$document", type: "graph-node", id: seeded.$keystone.id, revision: 1, attributes: { title: "Precondition verified" } }];
    const call = (preconditions: object[]) => f.app.call(path + "call", owner, { method: "POST", body: { action: "graph.apply", input: { requestKey, operations, preconditions } } });
    const valid = [{ type: "graph-node", id: seeded.$other.id, revision: 1 }];
    assert.equal((await call([{ ...valid[0], revision: 2 }])).status, 409);
    assert.equal((await f.get("graph-node", seeded.$keystone.id)).revision, 1);
    const receipt = await json(await call(valid));
    await json(await f.apply("precondition-endpoint-update", [{ operation: "update", ref: "$other", type: "graph-node", id: seeded.$other.id, revision: 1, attributes: { title: "Changed after receipt" } }]));
    assert.deepEqual(await json(await call(valid)), receipt);
    assert.equal((await f.get("graph-node", seeded.$keystone.id)).revision, 2);
    assert.equal(graphChangeInput.safeParse({ requestKey: "bounded", operations, preconditions: Array.from({ length: 101 }, () => valid[0]) }).success, false);
  } finally { await f.app.dispose(); }
});


test("delegated members atomically write node and edge data but cannot change definitions", async () => {
  const f = await fixture();
  try {
    const definitions = await json(await f.apply("definitions", sample()));
    const input = [
      create("$node", "graph-node", { typeId: definitions.$type.id, title: "Delegated draft" }),
      create("$edge", "graph-edge", { typeId: definitions.$relation.id, fromId: "$node", toId: definitions.$other.id }),
    ];
    const delegated = { ...member, entityWriter: "approved-caller" };
    assert.equal((await f.apply("not-delegated", input, member)).status, 403);
    const receipt = await json(await f.apply("delegated", input, delegated));
    assert.equal((await f.get("graph-node", receipt.$node.id)).attributes.provenance.createdBy, member.userId);
    assert.equal((await f.get("graph-edge", receipt.$edge.id)).attributes.fromId, receipt.$node.id);
    assert.deepEqual(await json(await f.apply("delegated", input, delegated)), receipt);
    assert.equal((await f.apply("forbidden-definition", [create("$type", "graph-type", { category: "node", name: "Forbidden", title: "Forbidden" })], delegated)).status, 403);
  } finally { await f.app.dispose(); }
});

test("source read sets detect newly inserted competing records before any mutation", async () => {
  const f = await fixture();
  try {
    const seeded = await json(await f.apply("set-seed", sample()));
    const operations = [{ operation: "update", ref: "$document", type: "graph-node", id: seeded.$keystone.id, revision: 1, attributes: { title: "Validated membership" } }];
    const readSets = [{ type: "graph-node", typeId: seeded.$type.id, records: [seeded.$keystone, seeded.$other] }];
    await json(await f.apply("new-competing-source", [create("$new", "graph-node", { typeId: seeded.$type.id, title: "Competing source" })]));
    const response = await f.app.call(path + "call", owner, { method: "POST", body: { action: "graph.apply", input: { requestKey: "stale-read-set", operations, readSets } } });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /source membership changed/);
    assert.equal((await f.get("graph-node", seeded.$keystone.id)).revision, 1);
  } finally { await f.app.dispose(); }
});

test("immutable type records cannot be edited by entity or graph changes", async () => {
  const f = await fixture();
  try {
    const receipt = await json(await f.apply("immutable-create", [
      create("$type", "graph-type", {category:"node",name:"ImmutableEvidence",title:"Immutable evidence",body:"Evidence",ontology:{version:2,immutable:true}}),
      create("$record", "graph-node", {typeId:"$type",title:"Original"}),
    ]));
    const update = {operation:"update",ref:"$record",type:"graph-node",id:receipt.$record.id,revision:1,attributes:{title:"Changed"}};
    assert.equal((await f.apply("immutable-update", [update])).status, 409);
    assert.equal((await f.app.call(entityPath + "update", owner, {method:"POST",body:{type:"graph-node",id:receipt.$record.id,revision:1,attributes:{archived:true}}})).status, 409);
    assert.equal((await f.apply("immutable-downgrade", [
      {operation:"update",ref:"$type",type:"graph-type",id:receipt.$type.id,revision:1,attributes:{ontology:{version:2}}}, update,
    ])).status, 409);
    const record = await f.get("graph-node", receipt.$record.id);
    assert.equal(record.attributes.title, "Original");
    assert.equal(record.revision, 1);
  } finally { await f.app.dispose(); }
});
