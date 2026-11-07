import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import baseSeed from "../seeds/entities-v1.json";
import graphSeed from "../seeds/knowledge-graphs-v1.json";
import artifacts from "../seeds/artifacts-v1.json";
import releases from "../seeds/releases-v1.json";
const seed = {
  ...baseSeed,
  nodes: [
    ...baseSeed.nodes,
    ...graphSeed.nodes,
    ...artifacts.nodes,
    ...releases.nodes,
  ],
  edges: [...baseSeed.edges, ...releases.edges],
};
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const member = { userId: "member", organizationId: "org", role: "member" };
const path = "/api/internal/entities/v1/";
// biome-ignore lint/suspicious/noExplicitAny: public JSON contract under test.
async function json(response: Response): Promise<any> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const artifact = () =>
  appArtifact(new URL("..", import.meta.url), "operational");

test("humans and agents share a persisted, typed Meze graph and canonical project", async () => {
  const app = await appWorker("wiki-map", artifact());
  const create = async (
    type: string,
    attributes: object,
    references: object[] = [],
  ) =>
    json(
      await app.call(path + "create", owner, {
        method: "POST",
        body: { type, attributes, references },
      }),
    );
  try {
    assert.equal(
      (
        await app.call("/api/internal/app-initialize", owner, {
          method: "POST",
          body: {},
        })
      ).status,
      200,
    );
    assert.equal((await app.call(path + "types")).status, 401);
    const types = await json(await app.call(path + "types", owner));
    assert.deepEqual(
      types.map((t: { type: string }) => t.type),
      ["graph-type", "graph-node", "graph-edge", "organization-goals"],
    );
    const project = await create(
      "graph-node",
      { typeId: core.project, title: "Meze", slug: "mezi" },
      [{ installationId: "planning", type: "project", id: "canonical-meze" }],
    );
    const projection = await json(await app.call(path + "list", member, { method: "POST", body: {
      type: "graph-node", filter: { source: { installationId: "planning", type: "project", id: "canonical-meze" } },
    } }));
    assert.deepEqual(projection.map((node: { ref: { id: string } }) => node.ref.id), [project.ref.id]);
    const unit = await create("graph-node", {
      typeId: core.unit,
      title: "Life Sciences",
    });
    const health = await create("graph-node", {
      typeId: core.software,
      title: "Apple Health",
    });
    const apple = await create("graph-node", {
      typeId: core.organization,
      title: "Apple",
    });
    const use = await create("graph-edge", {
      typeId: core.uses,
      fromId: project.ref.id,
      toId: health.ref.id,
      properties: {
        status: "proposed",
        evidence: "Owner requested exploration; no live connector verified.",
      },
    });
    await create("graph-edge", {
      typeId: core.belongs,
      fromId: project.ref.id,
      toId: unit.ref.id,
    });
    const developed = await create("graph-edge", {
      typeId: core.developed,
      fromId: health.ref.id,
      toId: apple.ref.id,
      properties: { evidence: "https://www.apple.com/health/" },
    });
    const graph = await json(
      await app.call("/api/apps/wiki-map/graph/snapshot", member),
    );
    assert.equal(graph.nodes.length, seed.nodes.length + 4);
    const seededIds = new Set(seed.nodes.map((node) => node.id));
    assert.equal(
      graph.edges.length,
      seed.edges.filter(
        (edge) => seededIds.has(edge.fromId) && seededIds.has(edge.toId),
      ).length + 3,
    );
    assert.equal(graph.canEdit, false);
    assert.equal(
      graph.nodes.find((n: { id: string }) => n.id === project.ref.id).source
        .id,
      "canonical-meze",
    );
    assert.equal(
      graph.edges.find((e: { id: string }) => e.id === use.ref.id).properties
        .status,
      "proposed",
    );
    const meaning = await json(
      await app.call(path + "get", member, {
        method: "POST",
        body: { type: "graph-type", id: core.uses },
      }),
    );
    assert.equal(meaning.attributes.category, "edge");
    assert.equal("fromTypes" in meaning.attributes, false);
    assert.equal(use.attributes.provenance.createdBy, "owner");
    const invalid = await app.call(path + "create", owner, {
      method: "POST",
      body: {
        type: "graph-edge",
        attributes: {
          typeId: core.uses,
          fromId: "70000000-0000-4000-8000-000000000099",
          toId: health.ref.id,
        },
      },
    });
    assert.equal(invalid.status, 400);
    const denied = await app.call(path + "create", member, {
      method: "POST",
      body: {
        type: "graph-node",
        attributes: { typeId: core.software, title: "Denied" },
      },
    });
    assert.equal(denied.status, 403);
    const externalProject = await app.call(path + "create", owner, {
      method: "POST",
      body: {
        type: "graph-node",
        attributes: { typeId: core.project, title: "External project" },
      },
    });
    assert.deepEqual((await json(externalProject)).references, []);
    const secondUnit = await create("graph-node", {
      typeId: core.unit,
      title: "Other unit",
    });
    assert.equal(
      (
        await app.call(path + "create", owner, {
          method: "POST",
          body: {
            type: "graph-edge",
            attributes: {
              typeId: core.belongs,
              fromId: project.ref.id,
              toId: secondUnit.ref.id,
            },
          },
        })
      ).status,
      200,
    );
    const changed = await json(
      await app.call(path + "update", owner, {
        method: "POST",
        body: {
          type: "graph-edge",
          id: use.ref.id,
          revision: 1,
          attributes: { body: "Investigate HealthKit separately" },
        },
      }),
    );
    assert.equal(changed.revision, 2);
    assert.equal(changed.attributes.properties.status, "proposed");
    assert.equal(
      (
        await app.call(path + "update", owner, {
          method: "POST",
          body: {
            type: "graph-edge",
            id: use.ref.id,
            revision: 1,
            attributes: { body: "stale" },
          },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await app.call(path + "update", owner, {
          method: "POST",
          body: {
            type: "graph-edge",
            id: use.ref.id,
            revision: 2,
            attributes: { provenance: { createdBy: "forged" } },
          },
        })
      ).status,
      400,
    );
    const bundle = await json(
      await app.call("/api/apps/wiki-map/graph/export", owner),
    );
    assert.ok(
      bundle.notes.some((n: { markdown: string }) =>
        n.markdown.includes('uses:\n  - "[[Nodes/Apple Health--'),
      ),
    );
    assert.ok(!JSON.stringify(bundle).includes("phones"));
    // Names are not identity: a second Apple gets its own address.
    const otherApple = await create("graph-node", {
      typeId: core.organization,
      title: "Apple",
    });
    assert.equal(otherApple.attributes.slug, "apple-2");
    // The browser adapter keeps references but cannot establish one.
    const browser = "/api/apps/wiki-map/graph/";
    assert.equal(
      (
        await app.call(browser + "create", owner, {
          method: "POST",
          body: {
            type: "graph-node",
            attributes: { typeId: core.project, title: "Unverified" },
            references: [
              { installationId: "planning", type: "project", id: "x" },
            ],
          },
        })
      ).status,
      403,
    );
    const kept = await json(
      await app.call(browser + "update", owner, {
        method: "POST",
        body: {
          type: "graph-node",
          id: project.ref.id,
          revision: 1,
          attributes: { summary: "Health data project" },
          references: [
            {
              installationId: "planning",
              type: "project",
              id: "canonical-meze",
            },
          ],
        },
      }),
    );
    assert.equal(kept.references[0].id, "canonical-meze");
    // Archiving a node leaves its relationships archivable.
    await json(
      await app.call(path + "update", owner, {
        method: "POST",
        body: {
          type: "graph-node",
          id: apple.ref.id,
          revision: 1,
          attributes: { archived: true },
        },
      }),
    );
    const archivedEdge = await json(
      await app.call(path + "update", owner, {
        method: "POST",
        body: {
          type: "graph-edge",
          id: developed.ref.id,
          revision: 1,
          attributes: { archived: true },
        },
      }),
    );
    assert.equal(archivedEdge.attributes.archived, true);
  } finally {
    await app.dispose();
  }
});

test("project-specific types and property forms share an extensible contract without new tables", async () => {
  const app = await appWorker("wiki-map", artifact());
  try {
    const type = await json(
      await app.call(path + "create", owner, {
        method: "POST",
        body: {
          type: "graph-type",
          attributes: {
            category: "node",
            name: "HealthDataSource",
            title: "Health data source",
            body: "A source evaluated by this project",
            properties: [
              {
                name: "format",
                type: "string",
                description: "Exchange format",
                required: true,
              },
            ],
          },
        },
      }),
    );
    assert.equal(
      (
        await app.call(path + "create", owner, {
          method: "POST",
          body: {
            type: "graph-node",
            attributes: { typeId: type.ref.id, title: "Missing format" },
          },
        })
      ).status,
      400,
    );
    const node = await json(
      await app.call(path + "create", owner, {
        method: "POST",
        body: {
          type: "graph-node",
          attributes: {
            typeId: type.ref.id,
            title: "Health export",
            properties: { format: "XML" },
          },
        },
      }),
    );
    assert.equal(node.attributes.properties.format, "XML");
    const edit = await json(
      await app.call(path + "update", owner, {
        method: "POST",
        body: {
          type: "graph-type",
          id: type.ref.id,
          revision: 1,
          attributes: { body: "Edited definition" },
        },
      }),
    );
    assert.equal(edit.revision, 2);
    assert.equal(
      (
        await app.call(path + "update", owner, {
          method: "POST",
          body: {
            type: "graph-type",
            id: type.ref.id,
            revision: 2,
            attributes: { properties: [] },
          },
        })
      ).status,
      400,
    );
    const archived = await json(
      await app.call(path + "update", owner, {
        method: "POST",
        body: {
          type: "graph-node",
          id: node.ref.id,
          revision: 1,
          attributes: { archived: true },
        },
      }),
    );
    assert.equal(archived.attributes.archived, true);
    const reread = await json(
      await app.call(path + "get", owner, {
        method: "POST",
        body: { type: "graph-type", id: type.ref.id },
      }),
    );
    assert.equal(
      reread.attributes.body,
      "Edited definition",
      "reads do not reconcile seeds over edits",
    );
  } finally {
    await app.dispose();
  }
});

test("schema migrations do not replay old seed data", async () => {
  const { readFile } = await import("node:fs/promises");
  const { migrateAppDatabase } =
    await import("@ai-outfitter/app-sdk/migrations");
  const pack = JSON.parse(await readFile(artifact(), "utf8"));
  const app = await appWorker("wiki-map", artifact());
  try {
    const initialized = await app.call("/api/internal/app-initialize", owner, {
      method: "POST",
      body: {},
    });
    assert.equal(initialized.status, 200);
    await app.database
      .prepare(
        "UPDATE graph_types SET body = 'Edited by owner', revision = 2 WHERE id = ?",
      )
      .bind(core.software)
      .run();
    await app.database
      .prepare("DELETE FROM graph_types WHERE id = ?")
      .bind(core.documents)
      .run();
    const applied = await migrateAppDatabase(
      {
        query: async (statement) =>
          (await app.database.prepare(statement).all<Record<string, unknown>>())
            .results,
        batch: async (statements) => {
          await app.database.batch(
            statements.map((statement) => app.database.prepare(statement)),
          );
        },
      },
      pack.manifest.database.migrations,
    );
    assert.deepEqual(applied, []);
    assert.equal(
      (
        await app.database
          .prepare("SELECT body FROM graph_types WHERE id = ?")
          .bind(core.software)
          .first()
      )?.body,
      "Edited by owner",
    );
    assert.equal(
      await app.database
        .prepare("SELECT id FROM graph_types WHERE id = ?")
        .bind(core.documents)
        .first(),
      null,
    );
    assert.equal(
      (
        await app.database
          .prepare("SELECT count(*) AS count FROM graph_nodes")
          .first()
      )?.count,
      seed.nodes.length,
    );
  } finally {
    await app.dispose();
  }
});

test("agents find exact types, nodes and incident edges without listing the wiki", async () => {
  const app = await appWorker("wiki-map", artifact());
  const list = async (type: string, filter?: object, paging = {}) =>
    json(
      await app.call(path + "list", member, {
        method: "POST",
        body: { type, ...(filter ? { filter } : {}), ...paging },
      }),
    );
  const create = async (type: string, attributes: object) =>
    json(
      await app.call(path + "create", owner, {
        method: "POST",
        body: { type, attributes },
      }),
    );
  try {
    const first = await create("graph-node", {
      id: "99000000-0000-4000-8000-000000000001",
      typeId: core.software,
      slug: "query-keystone",
      title: "Keystone 100%_literal",
    });
    const second = await create("graph-node", {
      id: "99000000-0000-4000-8000-000000000002",
      typeId: core.software,
      slug: "query-other",
      title: "Keystone other",
    });
    const archived = await create("graph-node", {
      id: "99000000-0000-4000-8000-000000000003",
      typeId: core.software,
      slug: "query-archived",
      title: "Keystone archived",
      archived: true,
    });
    const edge = await create("graph-edge", {
      typeId: core.uses,
      fromId: first.ref.id,
      toId: second.ref.id,
    });
    const reverse = await create("graph-edge", {
      typeId: core.uses,
      fromId: second.ref.id,
      toId: first.ref.id,
    });
    const ids = (records: { ref: { id: string } }[]) =>
      records.map((record) => record.ref.id);
    assert.deepEqual(
      ids(await list("graph-node", { slug: "query-keystone" })),
      [first.ref.id],
    );
    assert.deepEqual(ids(await list("graph-node", { titleContains: "%_" })), [
      first.ref.id,
    ]);
    assert.deepEqual(
      ids(
        await list(
          "graph-node",
          { titleContains: "KEYSTONE", typeId: core.software, archived: false },
          { offset: 1, limit: 1 },
        ),
      ),
      [second.ref.id],
    );
    assert.deepEqual(
      ids(await list("graph-node", { slug: "query-archived" })),
      [archived.ref.id],
    );
    assert.deepEqual(
      await list("graph-node", { slug: "query-archived", archived: false }),
      [],
    );
    assert.deepEqual(
      ids(
        await list("graph-node", { titleContains: "Keystone", archived: true }),
      ),
      [archived.ref.id],
    );
    assert.deepEqual(
      await list("graph-node", {
        typeId: core.organization,
        slug: "query-keystone",
      }),
      [],
    );
    assert.deepEqual(ids(await list("graph-edge", { fromId: first.ref.id })), [
      edge.ref.id,
    ]);
    assert.deepEqual(ids(await list("graph-edge", { toId: first.ref.id })), [
      reverse.ref.id,
    ]);
    assert.deepEqual(
      new Set(
        ids(
          await list("graph-edge", { nodeId: first.ref.id, typeId: core.uses }),
        ),
      ),
      new Set([edge.ref.id, reverse.ref.id]),
    );
    assert.equal(
      (await list("graph-type", { name: "Product", category: "node" }))
        .length,
      1,
    );
    assert.deepEqual(await list("graph-type", { name: "product" }), []);
    assert.deepEqual(
      await list("graph-type", { name: "Product", category: "edge" }),
      [],
    );
    assert.deepEqual(ids(await list("graph-node", { ids: [first.ref.id, archived.ref.id], archived: false })), [first.ref.id]);
    assert.deepEqual(new Set(ids(await list("graph-edge", { nodeIds: [first.ref.id], typeIds: [core.uses] }))), new Set([edge.ref.id, reverse.ref.id]));
    assert.deepEqual(new Set(ids(await list("graph-edge", { nodeIds: [first.ref.id], typeIds: [core.uses], fromTypeIds: [core.software] }))), new Set([edge.ref.id, reverse.ref.id]));
    assert.deepEqual(await list("graph-edge", { nodeIds: [first.ref.id], fromTypeIds: [core.organization] }), []);
    assert.equal((await list("graph-type", { names: ["Product"], category: "node" })).length, 1);
    for (const invalid of [[], Array(101).fill(first.ref.id)]) {
      assert.equal((await app.call(path + "list", member, { method: "POST", body: { type: "graph-node", filter: { ids: invalid } } })).status, 400);
    }
    const selected = await json(await app.call(path + "list", member, { method: "POST", body: {
      type: "graph-node", filter: { titleContains: "Keystone", archived: false },
      order: { field: "title", direction: "desc" }, select: ["id", "summary"], limit: 1,
    } }));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].title, "Keystone other");
    assert.deepEqual(Object.keys(selected[0].attributes), ["id", "summary"]);
    assert.equal(selected[0].ref.type, "graph-node");
    assert.equal((await app.call(path + "list", member, { method: "POST", body: { type: "graph-node", order: { field: "privateData", direction: "asc" } } })).status, 400);
    const discovery = await json(await app.call(path + "types", member));
    assert.ok(
      discovery.find((type: { type: string }) => type.type === "graph-node")
        .filterSchema.properties.slug,
    );
    for (const [type, filter] of [
      ["graph-node", { fromId: first.ref.id }],
      ["graph-edge", { archived: "false" }],
      ["graph-type", { titleContains: "" }],
    ]) {
      assert.equal(
        (
          await app.call(path + "list", member, {
            method: "POST",
            body: { type, filter },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await app.call(path + "list", undefined, {
          method: "POST",
          body: { type: "graph-node", filter: { slug: "query-keystone" } },
        })
      ).status,
      401,
    );
  } finally {
    await app.dispose();
  }
});
