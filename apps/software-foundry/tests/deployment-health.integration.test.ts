import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";

for (const mode of ["demo", "operational"] as const) {
  test(`${mode} package passes deployment health with its declared bindings`, async () => {
    const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), mode));
    try {
      const response = await app.call("/__health");
      const health = z.object({status:z.string(),database:z.string(),storage:z.string().optional()}).parse(await response.json());
      assert.equal(response.status, 200);
      assert.equal(health.status, "ok");
      assert.equal(health.database, mode === "demo" ? "none" : "ok");
      assert.equal(health.storage, mode === "demo" ? undefined : "ok");
    } finally { await app.dispose(); }
  });
}
