import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { drizzle } from "drizzle-orm/d1";
import { readRelationships, relationshipQuery } from "../src/lib/ontology-relationships";
import { readGraph } from "../src/server/graph";
import { confirmAssertion } from "../src/server/ontology-assertions";
import { importEntities } from "../src/server/entity-import";
import {
  identityHeaderValues,
  identityHeaders,
  encodeActor,
} from "@ai-outfitter/app-sdk/server";
import {
  ids,
  definitions,
  people,
  marriage,
  create,
  update,
  claimBody,
} from "./fixtures/relators";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const reader = { userId: "reader", organizationId: "org", role: "member" };
const actions = "/api/internal/actions/v1/call",
  assertions = "/api/apps/wiki-map/assertions/",
  entities = "/api/internal/entities/v1/";
// biome-ignore lint/suspicious/noExplicitAny: public JSON responses under test.
async function json(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function fixture() {
  const app = await appWorker(
    "wiki-map",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  // Assertions through the member's routes; relationships as the Wiki assistant reads them.
  const action = async (action: string, input: object, identity = owner) => {
    if (action === "graph.relationships")
      return Response.json(readRelationships(await readGraph(drizzle(app.database), {} as never), relationshipQuery.parse(input)));
    if (action.startsWith("assertion."))
      return app.call(assertions + action.slice("assertion.".length), identity, { method: "POST", body: input });
    return app.call(actions, identity, { method: "POST", body: { action, input } });
  };
  const apply = (
    operations: object[],
    requestKey: string = crypto.randomUUID(),
  ) => action("graph.apply", { requestKey, operations });
  const get = (type: string, id: string) =>
    app
      .call(`${entities}get`, owner, { method: "POST", body: { type, id } })
      .then(json);
  return { app, action, apply, get };
}
const complete = () => [...definitions(), ...people(), ...marriage()];

test("local imports validate complete relators atomically and preserve temporal episodes", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply([...definitions(), ...people()]));
  const db = drizzle(f.app.database);
  const who = { ...owner, installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  const node = { id: ids.union, typeId: ids.marriage, title: "Imported marriage", slug: "imported-marriage", validity: { from: "2026-01-01T00:00:00Z", to: null } };
  const edges = [ids.alex, ids.cristina].map((toId) => ({ id: crypto.randomUUID(), typeId: ids.spouse, fromId: ids.union, toId }));
  const file = { format: "outfitter-graph-entities-v1", nodes: [node], edges };
  await assert.rejects(importEntities(db, who, { ...file, edges: edges.slice(0, 1) }), (error: unknown) => error instanceof Response && error.status === 400);
  assert.equal(await f.app.database.prepare("SELECT id FROM graph_nodes WHERE id=?").bind(ids.union).first(), null);
  await importEntities(db, who, file);
  assert.deepEqual((await f.get("graph-node", ids.union)).attributes.validity, node.validity);
  for (const [from, to] of [["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"], ["2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z"]]) {
    const result = await importEntities(db, who, { format: file.format, nodes: [], edges: [{ id: crypto.randomUUID(), typeId: ids.friend, fromId: ids.alex, toId: ids.cristina, validity: { from, to } }] });
    assert.equal(result.edgesAdded, 1);
  }
  assert.equal((await json(await f.action("graph.relationships", { typeId: ids.friend, at: null }))).total, 2);
});

test("confirmation cannot borrow another member's receipt after an unrelated concurrent edit", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply([...complete(), create("$claim", "graph-node", { id: ids.claim, typeId: ids.assertion, title: "Claim", slug: "test-claim", body: JSON.stringify(claimBody()) })]));
  const reviewed = await json(await f.action("assertion.inspect", { id: ids.claim }));
  const input = { id: ids.claim, revision: 1, affirm: true as const, subjectHash: reviewed.subjectHash };
  await json(await f.action("assertion.confirm", input));
  const db = drizzle(f.app.database);
  const raced = new Proxy(db, { get(target, key) {
    if (key === "run") return async (query: Parameters<typeof db.run>[0]) => {
      await f.app.database.prepare("UPDATE graph_nodes SET revision=revision+1 WHERE id=?").bind(ids.product).run();
      return target.run(query);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const who = { ...owner, userId: "second-member", installationId: f.app.installationId, owner: { kind: "organization" as const, id: "org" }, canEdit: true };
  const actor = { kind: "member" as const, id: who.userId };
  await assert.rejects(confirmAssertion(raced, who, actor, actor, input), (error: unknown) => error instanceof Response && error.status === 409);
  assert.equal(await f.app.database.prepare("SELECT userId FROM graph_assertion_confirmations WHERE userId=?").bind(who.userId).first(), null);
  assert.equal((await confirmAssertion(db, who, actor, actor, input)).confirmed, true);
  assert.equal((await confirmAssertion(db, who, actor, actor, input)).confirmations.length, 2);
});

test("history preserves the current participant set on active relators", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  await json(await f.apply([
    update("$retire", "graph-edge", ids.secondSpouse, 1, { archived: true }),
    create("$replacement", "graph-edge", { typeId: ids.spouse, fromId: ids.union, toId: ids.nicholas }),
  ]));
  for (const includeArchived of [false, true]) {
    const result = await json(await f.action("graph.relationships", { typeId: ids.spouseOf, includeArchived, at: null }));
    assert.equal(result.total, 1);
    assert.deepEqual(new Set([result.relationships[0].fromId, result.relationships[0].toId]), new Set([ids.alex, ids.nicholas]));
  }
});

test("an archived subject cannot receive a current confirmation", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply([...complete(), create("$claim", "graph-node", { id: ids.claim, typeId: ids.assertion, title: "Claim", slug: "test-claim", body: JSON.stringify(claimBody(ids.product)) })]));
  await json(await f.apply([
    update("$archive", "graph-node", ids.product, 1, { archived: true }),
    update("$repin", "graph-node", ids.claim, 1, { body: JSON.stringify(claimBody(ids.product, 2)) }),
  ]));
  const reviewed = await json(await f.action("assertion.inspect", { id: ids.claim }));
  assert.equal(reviewed.subjectCurrent, false);
  assert.equal((await f.action("assertion.confirm", { id: ids.claim, revision: 2, affirm: true, subjectHash: reviewed.subjectHash })).status, 409);
});

test("relators, slots and participants are validated atomically, with actionable operation references", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const incomplete = complete().filter((op) => op.ref !== "$spouse2");
  const response = await f.apply(incomplete, "retryable");
  assert.equal(response.status, 400);
  const error = (await response.json()) as {
    errors: { rule: string; operationRefs: string[] }[];
  };
  assert.equal(error.errors[0].rule, "participation.minimum");
  assert.ok(error.errors[0].operationRefs.includes("$marriage"));
  assert.equal(
    await f.app.database
      .prepare("SELECT id FROM graph_nodes WHERE id=?")
      .bind(ids.union)
      .first(),
    null,
  );
  const saved = await json(await f.apply(complete(), "retryable"));
  assert.equal(saved.$marriage.id, ids.union);
  assert.equal(
    (await f.get("graph-node", ids.union)).attributes.validity.from,
    "2026-01-01T00:00:00Z",
  );
  assert.deepEqual(await json(await f.apply(complete(), "retryable")), saved);
});

test("wrong participant types, excess cardinality and cross-slot identity reuse are rejected", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const wrong = complete().map((op) =>
    op.ref === "$spouse2"
      ? { ...op, attributes: { ...op.attributes, toId: "$product" } }
      : op,
  );
  assert.equal((await f.apply(wrong)).status, 400);
  const excess = [
    ...complete(),
    create("$third", "graph-edge", {
      typeId: ids.spouse,
      fromId: ids.union,
      toId: ids.nicholas,
    }),
  ];
  assert.equal((await f.apply(excess)).status, 400);
  const assignment = [
    create("$assignment", "graph-node", {
      id: ids.assignmentNode,
      typeId: ids.assignment,
      title: "Assignment",
      slug: "test-assignment",
    }),
    create("$holder", "graph-edge", {
      typeId: ids.holder,
      fromId: ids.assignmentNode,
      toId: ids.alex,
    }),
    create("$roleLink", "graph-edge", {
      typeId: ids.role,
      fromId: ids.assignmentNode,
      toId: ids.roleNode,
    }),
    create("$scope", "graph-edge", {
      typeId: ids.scope,
      fromId: ids.assignmentNode,
      toId: ids.organization,
    }),
    create("$approver", "graph-edge", {
      typeId: ids.approver,
      fromId: ids.assignmentNode,
      toId: ids.alex,
    }),
  ];
  const samePerson = await f.apply([
    ...definitions(),
    ...people(),
    ...assignment,
  ]);
  assert.equal(samePerson.status, 400);
  assert.ok((await samePerson.text()).includes("participation.distinct"));
  const fixed = assignment.map((op) =>
    op.ref === "$approver"
      ? { ...op, attributes: { ...op.attributes, toId: ids.cristina } }
      : op,
  );
  await json(await f.apply([...definitions(), ...people(), ...fixed]));
});

test("spouse_of is a single read-only view, supports either direction and respects half-open business validity", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  const query = { typeId: ids.spouseOf, at: "2026-05-01T00:00:00Z" };
  const all = await json(await f.action("graph.relationships", query, reader));
  assert.equal(all.total, 1);
  assert.equal(all.relationships[0].source.id, ids.union);
  assert.equal(all.relationships[0].derived, true);
  for (const fromId of [ids.alex, ids.cristina]) {
    const view = await json(
      await f.action("graph.relationships", { ...query, fromId }),
    );
    assert.equal(view.total, 1);
    assert.equal(view.relationships[0].fromId, fromId);
    assert.equal(view.relationships[0].id, all.relationships[0].id);
  }
  assert.equal(
    (
      await f.apply([
        create("$duplicateFact", "graph-edge", {
          typeId: ids.spouseOf,
          fromId: ids.alex,
          toId: ids.cristina,
        }),
      ])
    ).status,
    400,
  );
  await json(
    await f.apply([
      update("$end", "graph-node", ids.union, 1, {
        validity: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
      }),
    ]),
  );
  assert.equal(
    (
      await json(
        await f.action("graph.relationships", {
          ...query,
          at: "2026-06-01T00:00:00Z",
        }),
      )
    ).total,
    0,
  );
  assert.equal(
    (await json(await f.action("graph.relationships", query))).total,
    1,
  );
});

test("incident relator constraints apply to entity writes, archival and type amendments", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  const direct = await f.app.call(`${entities}update`, owner, {
    method: "POST",
    body: {
      type: "graph-node",
      id: ids.alex,
      revision: 1,
      attributes: { archived: true },
    },
  });
  assert.equal(direct.status, 400);
  assert.equal(
    (
      await f.apply([
        update("$remove", "graph-edge", ids.firstSpouse, 1, { archived: true }),
      ])
    ).status,
    400,
  );
  const ontology = (await f.get("graph-type", ids.marriage)).attributes
    .ontology;
  ontology.participation.slots[0].min = 3;
  ontology.participation.slots[0].max = 3;
  assert.equal(
    (
      await f.apply([
        update("$type", "graph-type", ids.marriage, 1, { ontology }),
      ])
    ).status,
    400,
  );
  await json(
    await f.apply([
      update("$marriage", "graph-node", ids.union, 1, { archived: true }),
      update("$remove", "graph-edge", ids.firstSpouse, 1, { archived: true }),
      update("$remove2", "graph-edge", ids.secondSpouse, 1, { archived: true }),
      update("$person", "graph-node", ids.alex, 1, { archived: true }),
    ]),
  );
});

test("reversed symmetric duplicates and duplicate relators are rejected under concurrent writes", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  const [first, reverse] = await Promise.all([
    f.apply([
      create("$friend", "graph-edge", {
        typeId: ids.friend,
        fromId: ids.alex,
        toId: ids.nicholas,
      }),
    ]),
    f.apply([
      create("$friend", "graph-edge", {
        typeId: ids.friend,
        fromId: ids.nicholas,
        toId: ids.alex,
      }),
    ]),
  ]);
  assert.deepEqual([first.status, reverse.status].sort(), [200, 409]);
  for (const fromId of [ids.alex, ids.nicholas])
    assert.equal(
      (
        await json(
          await f.action("graph.relationships", { typeId: ids.friend, fromId }),
        )
      ).total,
      1,
    );
  const secondId = crypto.randomUUID();
  const duplicate = await f.apply([
    create("$marriage2", "graph-node", {
      id: secondId,
      typeId: ids.marriage,
      title: "Duplicate",
      slug: "test-duplicate",
    }),
    create("$one", "graph-edge", {
      typeId: ids.spouse,
      fromId: secondId,
      toId: ids.cristina,
    }),
    create("$two", "graph-edge", {
      typeId: ids.spouse,
      fromId: secondId,
      toId: ids.alex,
    }),
  ]);
  assert.equal(duplicate.status, 409);
  assert.ok((await duplicate.text()).includes("relator.duplicate"));
});

test("symmetric histories permit disjoint episodes and archived identities without allowing overlap", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply([...definitions(), ...people()]));
  const attrs = { typeId: ids.friend, fromId: ids.alex, toId: ids.nicholas };
  const first = await json(
    await f.apply([
      create("$friend", "graph-edge", {
        ...attrs,
        validity: { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" },
      }),
    ]),
  );
  await json(
    await f.apply([
      create("$next", "graph-edge", {
        ...attrs,
        validity: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      }),
    ]),
  );
  assert.equal(
    (
      await f.apply([
        create("$overlap", "graph-edge", {
          ...attrs,
          fromId: ids.nicholas,
          toId: ids.alex,
        }),
      ])
    ).status,
    409,
  );
  assert.equal(
    (
      await json(
        await f.action("graph.relationships", {
          typeId: ids.friend,
          at: "2026-02-01T00:00:00Z",
        }),
      )
    ).total,
    1,
  );
  assert.equal(
    (
      await json(
        await f.action("graph.relationships", { typeId: ids.friend, at: null }),
      )
    ).total,
    2,
  );
  await json(
    await f.apply([
      update("$archive", "graph-edge", first.$friend.id, 1, { archived: true }),
    ]),
  );
  await json(
    await f.apply([
      create("$replacement", "graph-edge", {
        ...attrs,
        validity: { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" },
      }),
    ]),
  );
  assert.equal(
    (
      await json(
        await f.action("graph.relationships", {
          typeId: ids.friend,
          at: null,
          includeArchived: true,
        }),
      )
    ).total,
    3,
  );
});

test("invalid intervals and slot-specific dates are refused without weakening cardinality", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  for (const validity of [
    { from: "2026-03-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    { from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    { from: "2026-02-30T00:00:00Z", to: null },
  ]) {
    const operations = complete().map((op) =>
      op.ref === "$marriage"
        ? { ...op, attributes: { ...op.attributes, validity } }
        : op,
    );
    assert.equal((await f.apply(operations)).status, 400);
  }
  const operations = complete().map((op) =>
    op.ref === "$spouse1"
      ? {
          ...op,
          attributes: { ...op.attributes, validity: { from: null, to: null } },
        }
      : op,
  );
  assert.equal((await f.apply(operations)).status, 400);
});

test("assertions preserve evidence and uncertainty, resolve batch subjects, and require real user confirmation", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  const body = claimBody("$marriage");
  await json(
    await f.apply([
      ...complete(),
      create("$claim", "graph-node", {
        id: ids.claim,
        typeId: ids.assertion,
        title: "Synthetic claim",
        slug: "test-claim",
        body: JSON.stringify(body),
      }),
    ]),
  );
  let claim = await json(
    await f.action("assertion.inspect", { id: ids.claim }, reader),
  );
  assert.equal(claim.confirmed, false);
  assert.equal(claim.assertion.subject.id, ids.union);
  assert.equal(claim.assertion.evidence[0].recordId, "synthetic-event");
  const wrong = await f.action("assertion.confirm", {
    id: ids.claim,
    revision: 2,
    affirm: true,
    subjectHash: claim.subjectHash,
  });
  assert.equal(wrong.status, 409);
  claim = await json(
    await f.action("assertion.confirm", {
      id: ids.claim,
      revision: 1,
      affirm: true,
      subjectHash: claim.subjectHash,
    }),
  );
  assert.equal(claim.confirmed, true);
  assert.equal(claim.confirmations[0].userId, owner.userId);
  assert.deepEqual(
    (
      await json(
        await f.action("assertion.confirm", {
          id: ids.claim,
          revision: 1,
          affirm: true,
          subjectHash: claim.subjectHash,
        }),
      )
    ).confirmations,
    claim.confirmations,
  );
  // The member's own connection confirms with the member's identity; an app never does.
  for (const [actor, status] of [
    [{ kind: "oauth-client" as const, id: "synthetic-agent" }, 200],
    [{ kind: "app" as const, id: "forerunner" }, 403],
  ] as const) {
    const headers = {
      ...identityHeaderValues({
        ...owner,
        installationId: f.app.installationId,
      }),
      [identityHeaders.actor]: encodeActor(actor),
    };
    const response = await f.app.fetch(`${f.app.origin}${assertions}confirm`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: ids.claim,
        revision: 1,
        affirm: true,
        subjectHash: claim.subjectHash,
      }),
    });
    assert.equal(response.status, status, await response.clone().text());
  }
  assert.equal(
    (
      await f.action(
        "assertion.confirm",
        {
          id: ids.claim,
          revision: 1,
          affirm: true,
          subjectHash: claim.subjectHash,
        },
        { ...owner, userId: "resident:example:agent" },
      )
    ).status,
    403,
  );
  await json(
    await f.apply([
      update("$subject", "graph-node", ids.union, 1, {
        title: "Changed subject",
      }),
    ]),
  );
  claim = await json(await f.action("assertion.inspect", { id: ids.claim }));
  assert.equal(claim.subjectCurrent, false);
  assert.equal(claim.confirmed, false);
  assert.equal(claim.confirmations.length, 1);
  assert.equal(
    (
      await f.action("assertion.confirm", {
        id: ids.claim,
        revision: 1,
        affirm: true,
        subjectHash: claim.subjectHash,
      })
    ).status,
    409,
  );
});

test("forged confirmation, nonexistent subjects and edits to confirmed assertions cannot manufacture truth", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  const makeClaim = (body: object) =>
    create("$claim", "graph-node", {
      id: ids.claim,
      typeId: ids.assertion,
      title: "Claim",
      slug: "test-claim",
      body: JSON.stringify(body),
    });
  for (const body of [
    { ...claimBody(), status: "confirmed" },
    { ...claimBody(), confirmation: { userId: "owner" } },
    claimBody(crypto.randomUUID()),
    claimBody(ids.union, 99),
  ])
    assert.equal((await f.apply([makeClaim(body)])).status, 400);
  await json(await f.apply([makeClaim(claimBody())]));
  const reviewed = await json(
    await f.action("assertion.inspect", { id: ids.claim }),
  );
  await json(
    await f.action("assertion.confirm", {
      id: ids.claim,
      revision: 1,
      affirm: true,
      subjectHash: reviewed.subjectHash,
    }),
  );
  const body = claimBody();
  body.uncertainty.reason = "Evidence revised after review.";
  await json(
    await f.apply([
      update("$amend", "graph-node", ids.claim, 1, {
        body: JSON.stringify(body),
      }),
    ]),
  );
  const changed = await json(
    await f.action("assertion.inspect", {
      id: ids.claim,
      includeHistory: true,
    }),
  );
  assert.equal(changed.confirmed, false);
  assert.equal(changed.confirmations[0].assertionRevision, 1);
  assert.equal(changed.revision, 2);
  assert.equal(
    (await json(await f.action("graph.relationships", { typeId: ids.friend })))
      .total,
    0,
  );
});

test("participant changes invalidate confirmation even when the relator node revision is unchanged", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(
    await f.apply([
      ...complete(),
      create("$claim", "graph-node", {
        id: ids.claim,
        typeId: ids.assertion,
        title: "Claim",
        slug: "test-claim",
        body: JSON.stringify(claimBody()),
      }),
    ]),
  );
  const reviewed = await json(
    await f.action("assertion.inspect", { id: ids.claim }),
  );
  const input = {
    id: ids.claim,
    revision: 1,
    affirm: true,
    subjectHash: reviewed.subjectHash,
  };
  await json(await f.action("assertion.confirm", input));
  await json(
    await f.apply([
      update("$participant", "graph-edge", ids.secondSpouse, 1, {
        toId: ids.nicholas,
      }),
    ]),
  );
  const changed = await json(
    await f.action("assertion.inspect", { id: ids.claim }),
  );
  assert.equal(changed.subjectCurrent, true);
  assert.equal(changed.confirmed, false);
  assert.notEqual(changed.subjectHash, reviewed.subjectHash);
  assert.equal((await f.action("assertion.confirm", input)).status, 409);
  const confirmed = await json(
    await f.action("assertion.confirm", {
      ...input,
      subjectHash: changed.subjectHash,
    }),
  );
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.confirmations.length, 2);
});

test("portable graphs preserve assertion evidence and subject revisions, while confirmations remain installation-scoped", async (t) => {
  const f = await fixture(),
    destination = await fixture();
  t.after(() => Promise.all([f.app.dispose(), destination.app.dispose()]));
  await json(
    await f.apply([
      ...complete(),
      create("$claim", "graph-node", {
        id: ids.claim,
        typeId: ids.assertion,
        title: "Claim",
        slug: "test-claim",
        body: JSON.stringify(claimBody()),
      }),
    ]),
  );
  const reviewed = await json(
    await f.action("assertion.inspect", { id: ids.claim }),
  );
  await json(
    await f.action("assertion.confirm", {
      id: ids.claim,
      revision: 1,
      affirm: true,
      subjectHash: reviewed.subjectHash,
    }),
  );
  await json(
    await f.apply([
      update("$subject", "graph-node", ids.union, 1, {
        title: "Revised subject",
      }),
      update("$claim", "graph-node", ids.claim, 1, {
        body: JSON.stringify(claimBody(ids.union, 2)),
      }),
    ]),
  );
  const exported = await json(
    await f.app.call("/api/apps/wiki-map/graph/export", owner),
  );
  assert.equal(exported.confirmationArchive.confirmations.length, 1);
  assert.equal(
    exported.confirmationArchive.confirmations[0].assertionBody.subject
      .revision,
    1,
  );
  assert.equal(
    exported.confirmationArchive.confirmations[0].subjectSnapshot.record.title,
    "Synthetic marriage",
  );
  const transferred = exported.transfer.nodes.find(
    (n: { id: string }) => n.id === ids.union,
  );
  assert.equal(transferred.revision, 2);
  const preview = await json(
    await destination.app.call("/api/apps/wiki-map/graph/preview", owner, {
      method: "POST",
      body: exported.transfer,
    }),
  );
  await json(
    await destination.app.call("/api/apps/wiki-map/graph/restore", owner, {
      method: "POST",
      body: { transfer: exported.transfer, previewToken: preview.previewToken },
    }),
  );
  const restored = await json(
    await destination.action("assertion.inspect", { id: ids.claim }),
  );
  assert.equal(restored.revision, 2);
  assert.equal(restored.subjectCurrent, true);
  assert.equal(restored.confirmed, false);
  assert.deepEqual(restored.confirmations, []);
  assert.deepEqual(restored.assertion, claimBody(ids.union, 2));
  for (const revision of [1, 3]) {
    const mismatched = structuredClone(exported.transfer);
    mismatched.nodes.find((node: { id: string }) => node.id === ids.union).revision = revision;
    const newClaim = mismatched.nodes.find((node: { id: string }) => node.id === ids.claim);
    newClaim.id = crypto.randomUUID();
    newClaim.slug = `revision-conflict-${revision}`;
    newClaim.body = JSON.stringify(claimBody(ids.union, revision));
    const conflict = await destination.app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: mismatched });
    assert.equal(conflict.status, 409);
    assert.match(await conflict.text(), /subject revision differs/);
  }
});

test("stale historical assertions survive initial and repeated portable restores", async (t) => {
  const source = await fixture(), destination = await fixture();
  t.after(() => Promise.all([source.app.dispose(), destination.app.dispose()]));
  await json(await source.apply([...complete(), create("$claim", "graph-node", { id: ids.claim, typeId: ids.assertion, title: "Historical claim", slug: "historical-claim", body: JSON.stringify(claimBody()) })]));
  await json(await source.apply([update("$subject", "graph-node", ids.union, 1, { title: "Revised subject" })]));
  const exported = await json(await source.app.call("/api/apps/wiki-map/graph/export", owner));
  await json(await source.app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: exported.transfer }));
  const plan = await json(await destination.app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: exported.transfer }));
  await json(await destination.app.call("/api/apps/wiki-map/graph/restore", owner, { method: "POST", body: { transfer: exported.transfer, previewToken: plan.previewToken } }));
  await json(await destination.app.call("/api/apps/wiki-map/graph/preview", owner, { method: "POST", body: exported.transfer }));
  assert.equal((await json(await destination.action("assertion.inspect", { id: ids.claim }))).subjectCurrent, false);
});

test("portable export refuses to omit required canonical participants", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  await f.app.database.prepare("UPDATE graph_nodes SET source=?, revision=revision+1 WHERE id=?").bind(JSON.stringify({ installationId: "people", type: "person", id: "canonical" }), ids.alex).run();
  const exported = await json(await f.app.call("/api/apps/wiki-map/graph/export", owner));
  assert.equal(exported.transfer, null);
  assert.ok(exported.transferOmissions.nodes.includes(ids.alex));
  assert.ok(exported.transferLimitations.some((message: string) => message.includes("ontology dependencies")));
});

test("invalid relator declarations and attempts to amend a stale asserted subject fail closed", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  const definition = (await f.get("graph-type", ids.marriage)).attributes
    .ontology;
  const invalids = [
    {
      ...definition,
      participation: {
        ...definition.participation,
        slots: [{ ...definition.participation.slots[0], min: 3, max: 2 }],
      },
    },
    {
      ...definition,
      participation: { ...definition.participation, distinct: [["missing"]] },
    },
    {
      ...definition,
      participation: {
        ...definition.participation,
        slots: [
          { ...definition.participation.slots[0], edgeTypeId: ids.spouseOf },
        ],
      },
    },
  ];
  for (const ontology of invalids)
    assert.equal(
      (
        await f.apply([
          update("$invalid", "graph-type", ids.marriage, 1, { ontology }),
        ])
      ).status,
      400,
    );
  await json(
    await f.apply([
      update("$subject", "graph-node", ids.union, 1, { title: "Revised" }),
    ]),
  );
  const stale = await f.apply([
    create("$claim", "graph-node", {
      typeId: ids.assertion,
      title: "Stale",
      slug: "stale-assertion",
      body: JSON.stringify(claimBody()),
    }),
  ]);
  assert.equal(stale.status, 400);
  assert.ok((await stale.text()).includes("assertion.subject_revision"));
});

test("moving a connection cannot worsen a pre-existing invalid source relator", async (t) => {
  const f = await fixture();
  t.after(() => f.app.dispose());
  await json(await f.apply(complete()));
  // Simulate legacy damage outside the API: the source already lacks one participant.
  await f.app.database
    .prepare("UPDATE graph_edges SET archived=1 WHERE id=?")
    .bind(ids.secondSpouse)
    .run();
  const moved = await f.apply([
    update("$move", "graph-edge", ids.firstSpouse, 1, {
      fromId: ids.nicholas,
      typeId: ids.friend,
    }),
  ]);
  assert.equal(moved.status, 400);
  assert.ok((await moved.text()).includes("participation.minimum"));
  const unrelated = await f.apply([
    update("$unrelated", "graph-node", ids.product, 1, {
      title: "Unrelated edit",
    }),
  ]);
  assert.equal(unrelated.status, 200);
});

test("personal owner scope supports assertions without an organization and cannot read another installation's claims", async (t) => {
  const own = await fixture(),
    other = await fixture();
  t.after(() => Promise.all([own.app.dispose(), other.app.dispose()]));
  const headers = {
    ...identityHeaderValues({
      userId: "personal-owner",
      owner: { kind: "user", id: "personal-owner" },
      installationId: own.app.installationId,
      role: "owner",
    }),
    "Content-Type": "application/json",
  };
  const operations = [
    ...complete(),
    create("$claim", "graph-node", {
      id: ids.claim,
      typeId: ids.assertion,
      title: "Personal claim",
      slug: "personal-claim",
      body: JSON.stringify(claimBody()),
    }),
  ];
  await json(
    await own.app.fetch(own.app.origin + actions, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "graph.apply",
        input: { requestKey: "personal", operations },
      }),
    }),
  );
  const inspected = await json(
    await own.app.fetch(`${own.app.origin}${assertions}inspect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: ids.claim }),
    }),
  );
  const confirmed = await json(
    await own.app.fetch(`${own.app.origin}${assertions}confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: ids.claim,
        revision: 1,
        subjectHash: inspected.subjectHash,
        affirm: true,
      }),
    }),
  );
  assert.equal(confirmed.confirmations[0].userId, "personal-owner");
  assert.equal(
    (await other.action("assertion.inspect", { id: ids.claim })).status,
    404,
  );
});
