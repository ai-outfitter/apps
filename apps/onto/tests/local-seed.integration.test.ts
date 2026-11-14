import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { loadPersonalSeed } from "../scripts/personal-seed";
import { core } from "../src/lib/graph";
import { readGraph } from "../src/server/graph";

test("local seeds import more than one relationship batch without duplicating on restart", async () => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const directory = await mkdtemp(join(tmpdir(), "wiki-seed-"));
  const identity = {
    userId: "seed-owner",
    installationId: "seed-wiki",
    owner: { kind: "user" as const, id: "seed-owner" },
    role: "owner",
    canEdit: true,
  };
  try {
    const nodes = Array.from({ length: 110 }, (_, index) => ({
      id: randomUUID(),
      typeId: core.entity,
      title: `Entity ${index}`,
      slug: `batch-entity-${index}`,
    }));
    const relationshipId = randomUUID();
    const edges = nodes.slice(0, 3).flatMap((from) =>
      nodes.slice(3, 70).map((to) => ({
        id: randomUUID(),
        typeId: relationshipId,
        fromId: from.id,
        toId: to.id,
        properties: {},
      })),
    );
    assert.equal(edges.length, 201);
    delete (nodes[0] as { slug?: string }).slug;
    nodes[1].slug = "entity-0";
    const customType = {
      id: randomUUID(),
      category: "node",
      name: "LocalCustom",
      title: "Local custom",
      body: "Custom context",
      properties: [],
    };
    nodes[109].typeId = customType.id;
    const path = pathToFileURL(join(directory, "personal.local.json"));
    await writeFile(
      path,
      JSON.stringify({
        format: "outfitter-graph-entities-v1",
        nodes,
        edges,
        types: [customType, {id: relationshipId,category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } },name: "BulkFixtureRelationship",title: "Bulk fixture relationship",body: "Uncontracted synthetic relationship for pagination coverage.",properties: []}],
      }),
    );
    const host = {
      async call() {
        throw new Error("Non-project seeds must not call the host");
      },
    };
    const db = drizzle(app.database);
    for (let restart = 0; restart < 2; restart++) {
      await loadPersonalSeed(db, identity, host, path);
      const graph = await readGraph(db, identity);
      assert.equal(
        graph.nodes.filter((n) => nodes.some((source) => source.id === n.id))
          .length,
        110,
      );
      assert.equal(
        graph.edges.filter((edge) =>
          nodes.some((node) => node.id === edge.fromId),
        ).length,
        201,
      );
    }
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloaded projects bind to local Planning and reuse their receipt on restart", async () => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const directory = await mkdtemp(join(tmpdir(), "wiki-project-seed-"));
  const identity = {
    userId: "seed-owner",
    installationId: "seed-wiki",
    owner: { kind: "user" as const, id: "seed-owner" },
    role: "owner",
    canEdit: true,
  };
  const projectId = randomUUID();
  const localRef = {
    installationId: "local-planning",
    type: "project",
    id: randomUUID(),
  };
  let creates = 0;
  const host = {
    async call(operation: string, input: unknown) {
      if (operation === "entities.types")
        return {
          ok: true as const,
          value: [
            {
              type: "project",
              writable: true,
              installationId: "local-planning",
            },
          ],
        };
      if (operation === "entities.create") {
        creates++;
        return { ok: true as const, value: { ref: localRef } };
      }
      if (operation === "entities.get") {
        assert.deepEqual(input, localRef);
        return { ok: true as const, value: { ref: localRef } };
      }
      throw new Error(`Unexpected operation ${operation}`);
    },
  };
  try {
    const path = pathToFileURL(join(directory, "personal.local.json"));
    await writeFile(
      path,
      JSON.stringify({
        format: "outfitter-graph-entities-v1",
        nodes: [],
        projects: [
          {
            id: projectId,
            typeId: core.project,
            title: "Downloaded project",
            source: {
              installationId: "deployed-planning",
              type: "project",
              id: randomUUID(),
            },
          },
        ],
      }),
    );
    const db = drizzle(app.database);
    await loadPersonalSeed(db, identity, host, path);
    await loadPersonalSeed(db, identity, host, path);
    assert.equal(creates, 1);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).projects[0].source
        .installationId,
      "deployed-planning",
    );
    assert.deepEqual(
      (await readGraph(db, identity)).nodes.find(
        (node) => node.id === projectId,
      )?.source,
      localRef,
    );
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
