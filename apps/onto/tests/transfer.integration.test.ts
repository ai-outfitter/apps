import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { core } from "../src/lib/graph";
import {
  exportFile,
  transferFile,
  uploadFile,
  ToolRefusal,
  type Call,
  type Journal,
} from "../scripts/transfer";

test("transfer round trip uses the real Wiki entity provider and preserves independent edits", async () => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  const identity = {
    userId: "transfer-owner",
    organizationId: "transfer-org",
    role: "owner",
  };
  const journal: Journal = {
    endpoint: "https://example.test/mcp",
    wiki: app.installationId,
    entries: {},
  };
  const call: Call = async (name, args) => {
    const { installationId: _installation, ...body } = args;
    const operation = (
      {
        list_entities: "list",
        get_entity: "get",
        create_entity: "create",
        update_entity: "update",
      } as Record<string, string>
    )[name];
    const response = await app.call(
      `/api/internal/entities/v1/${operation}`,
      identity,
      { method: "POST", body },
    );
    if (!response.ok) throw new ToolRefusal(await response.text());
    return response.json();
  };
  try {
    const first = randomUUID(),
      second = randomUUID(),
      custom = randomUUID();
    const file = transferFile.parse({
      format: "outfitter-graph-entities-v1",
      types: [
        {
          id: custom,
          category: "node",
          name: "TransferItem",
          title: "Transfer item",
          body: "A transferable item",
        },
      ],
      nodes: [first, second].map((id) => ({
        id,
        typeId: custom,
        title: "Same name",
        body: "original",
      })),
      edges: [
        { id: randomUUID(), typeId: "71000000-0000-4000-8000-000000000032", fromId: first, toId: second },
      ],
    });
    assert.deepEqual(
      await uploadFile(call, file, journal, async () => {}, true),
      { create: 4, update: 0, unchanged: 0 },
    );
    const ref = journal.entries[`graph-node/${first}`].ref;
    const current = (await call("get_entity", ref)) as { revision: number };
    await call("update_entity", {
      ...ref,
      revision: current.revision,
      attributes: { body: "live agent documentation" },
      references: [],
    });
    file.nodes[0].summary = "local summary";
    await uploadFile(call, file, journal, async () => {}, true);
    const exported = await exportFile(call, journal);
    const node = exported.nodes.find((row) => row.id === first);
    assert.equal(node?.typeId, custom);
    assert.equal(node?.body, "live agent documentation");
    assert.equal(node?.summary, "local summary");
    const edge = exported.edges.find((row) => row.id === file.edges[0].id);
    assert.equal(edge?.fromId, first);
    assert.equal(edge?.toId, second);
    assert.equal(
      (await uploadFile(call, exported, journal, async () => {}, true)).create,
      0,
    );
  } finally {
    await app.dispose();
  }
});
