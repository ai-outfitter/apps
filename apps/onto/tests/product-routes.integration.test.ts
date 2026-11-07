import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";

test("legacy product pages redirect through the built Astro worker", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  try {
    for (const suffix of ["", "/node-id", "/node-id/connections", "/node-id/knowledge-graphs", "/node-id/knowledge-graphs/lens-id"]) {
      const response = await app.fetch(`${app.origin}/software-products${suffix}?view=details`, { redirect: "manual" });
      assert.equal(response.status, 308, `${suffix}: ${await response.clone().text()}`);
      assert.equal(response.headers.get("location"), `/products${suffix}?view=details`);
    }
  } finally { await app.dispose(); }
});
