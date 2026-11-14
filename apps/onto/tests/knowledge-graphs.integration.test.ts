import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "./fixtures/initialized-worker";
import { core } from "../src/lib/graph";
import seed from "../seeds/knowledge-graphs-v1.json";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
test("knowledge graph definitions are ordinary editable Wiki nodes with validated traversal", async () => {
  const app = await appWorker(
    "onto",
    new URL(
      "../.outfitter/packages/operational.json",
      import.meta.url,
    ),
  );
  try {
    const create = async (pattern: string) =>
      app.call("/api/apps/onto/graph/create", owner, {
        method: "POST",
        body: {
          type: "graph-node",
          attributes: {
            typeId: core.knowledgeGraph,
            title: "Custom offering lens",
            body: "Why: inspect dependency ownership.",
            properties: { root_type: "Offering", pattern },
          },
        },
      });
    assert.equal((await create("not json")).status, 400);
    assert.equal(
      (await create(JSON.stringify({ relationships: ["uses"], max_depth: 0 })))
        .status,
      400,
    );
    assert.equal(
      (
        await create(
          JSON.stringify({
            relationships: ["unknown_relationship"],
            max_depth: 4,
          }),
        )
      ).status,
      400,
    );
    const saved = await create(seed.nodes[0].properties.pattern);
    assert.equal(saved.status, 200);
    const record = (await saved.json()) as { ref: { id: string } };
    const snapshot = await app.call("/api/apps/onto/graph/snapshot", owner);
    const data = (await snapshot.json()) as {
      nodes: { id: string; typeId: string; body: string }[];
    };
    assert.equal(
      data.nodes.find((n) => n.id === record.ref.id)?.typeId,
      core.knowledgeGraph,
    );
    assert.match(
      data.nodes.find((n) => n.id === record.ref.id)?.body ?? "",
      /inspect dependency ownership/,
    );
  } finally {
    await app.dispose();
  }
});
