import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import baseSeed from "../graph/.compiled/entities-v1.json" with { type: "json" };
import graphSeed from "../graph/.compiled/knowledge-graphs-v1.json" with { type: "json" };
import artifacts from "../graph/.compiled/artifacts-v1.json" with { type: "json" };
import releases from "../graph/.compiled/releases-v1.json" with { type: "json" };
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
import { defaultTypes } from "../src/lib/default-types";

test("fresh installations expose the shared type pages to readers and agents", async () => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const member = { userId: "reader", organizationId: "org", role: "member" };
  try {
    const initialized = await app.call("/api/internal/app-initialize", { userId: "installer", organizationId: "org", role: "owner" }, { method: "POST", body: {} });
    assert.equal(initialized.status, 200);
    const records: { attributes: { name: string; body: string; archived: boolean; jsonSchema?: unknown }; ref: { id: string } }[] = [];
    for (let after: string | null = null; ; ) {
      const response = await app.call("/api/internal/entities/v1/list", member, { method: "POST", body: { type: "graph-type", limit: 100, ...(after ? { after } : {}) } });
      assert.equal(response.status, 200);
      const page = await response.json() as { records: typeof records; pageInfo: { endCursor: string | null } };
      records.push(...page.records);
      after = page.pageInfo.endCursor;
      if (!after) break;
    }
    assert.ok(!records.some((record) => record.ref.id === "71000000-0000-4000-8000-000000000008"), "fresh JSON initialization omits retired legacy definitions");
    assert.deepEqual(records.filter((record) => !record.attributes.archived).map((record) => record.ref.id).sort(), defaultTypes.map((type) => type.id).sort());
    for (const name of [
      "Entity",
      "Project",
      "Person",
      "Organization",
      "Technology",
      "Agent",
      "uses",
      "Activity",
      "Asset",
      "FinancialObligation",
      "Friendship",
      "ControlDefinition",
      "ControlCommitment",
      "ResponseObligation",
      "SourceIssueEpisode",
    ]) {
      const expected = defaultTypes.find((t) => t.name === name)!;
      const actual = records.find((t) => t.attributes.name === name)!;
      assert.equal(actual.ref.id, expected.id);
      assert.equal(actual.attributes.body, expected.body);
      assert.match(actual.attributes.body, /For agents/);
    }
    for (const type of defaultTypes.filter((t) => t.jsonSchema)) {
      assert.deepEqual(records.find((t) => t.ref.id === type.id)?.attributes.jsonSchema, type.jsonSchema);
    }
    const snapshot = (await (
      await app.call("/api/apps/onto/graph/snapshot", member)
    ).json()) as {
      types: unknown[];
      nodes: { id: string; title: string; properties: Record<string, unknown> }[];
      edges: { id: string }[];
    };
    assert.equal(snapshot.types.length, records.length);
    const seededIds = new Set(seed.nodes.map((node) => node.id));
    assert.deepEqual(
      snapshot.edges.map((edge) => edge.id).sort(),
      seed.edges
        .filter(
          (edge) => seededIds.has(edge.fromId) && seededIds.has(edge.toId),
        )
        .map((edge) => edge.id)
        .sort(),
      "relationships between public seed nodes are installed without local startup",
    );
    assert.equal(
      snapshot.nodes.length,
      seed.nodes.length + 1,
      "standard records and exactly one canonical owner root are initialized",
    );
    const ownerNodes = snapshot.nodes.filter((n) => !seededIds.has(n.id));
    assert.equal(ownerNodes.length, 1);
    assert.equal(ownerNodes[0].properties.organization_id, "org");
    assert.deepEqual(
      snapshot.nodes.filter((n) => seededIds.has(n.id)).map((n) => n.title).sort((a, b) => a.localeCompare(b)),
      seed.nodes.map((n) => n.title).sort((a, b) => a.localeCompare(b)),
    );
  } finally {
    await app.dispose();
  }
});
