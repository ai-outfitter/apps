import assert from "node:assert/strict";
import { appWorker as rawAppWorker } from "@ai-outfitter/app-test/worker";

/** Mirror installation: migrate blank schema, then invoke the public JSON
 * initializer. Tests of blank databases/initialization keep the raw worker. */
export async function appWorker(...args: Parameters<typeof rawAppWorker>) {
  const app = await rawAppWorker(...args);
  try {
    const response = await app.call("/api/internal/app-initialize", {
      userId: "synthetic-initializer", organizationId: "synthetic-initializer", role: "owner",
    }, { method: "POST", body: {} });
    assert.equal(response.status, 200, await response.clone().text());
    return app;
  } catch (error) {
    await app.dispose();
    throw error;
  }
}
