import assert from "node:assert/strict";
import test from "node:test";
import { queryGraph } from "@ai-outfitter/app-sdk/graph-query";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readProjectWikiBody } from "../src/server/project-wiki-body";
import { projectReleasesFixture, releaseId, releaseProviders } from "./fixtures/project-releases";

function fixture(refusal?: number) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const graph = projectReleasesFixture();
  const host = {
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === "entities.types") return releaseProviders();
      assert.equal(operation, "actions.call");
      assert.equal(input.installationId, "wiki");
      assert.equal(input.readOnly, true);
      if (refusal) throw new Response("Graph unavailable", { status: refusal });
      assert.equal(input.action, "graph.query");
      return queryGraph({ version: 1, installationId: "wiki", ...graph, selection: null, truncated: false, missingTypes: [] } as never, input.input as never);
    },
  } as unknown as WorkflowHost<"interactive">;
  return { host, calls };
}

test("project body uses bounded reads and selects the canonical installation's evidence", async () => {
  const { host, calls } = fixture();
  const body = await readProjectWikiBody(host, "planning", releaseId(9));
  assert.ok(body);
  assert.equal(body.release?.title, "Sensor draft press release");
  assert.ok(body.documents.some(row => row.title === "Sensor press release and evidence bundle"));
  assert.equal(body.documents.some(row => row.title === "Foreign evidence"), false);
  assert.equal(calls.some(call => call.input.action === "graph.read"), false);
  const query = calls.find(call => call.input.action === "graph.query");
  assert.ok(query);
  assert.match(JSON.stringify(query.input), /"installationId":"planning"/);
});

for (const status of [403, 503, 413])
  test(`project body preserves text fallback when graph access returns ${status}`, async () => {
    const { host, calls } = fixture(status);
    assert.equal(await readProjectWikiBody(host, "planning", releaseId(9)), null);
    assert.equal(calls.some(call => call.input.action === "graph.read"), false);
  });
