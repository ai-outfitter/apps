import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";

const member = { userId: "alice", organizationId: "org", role: "member" };
const focus = "eb000000-0000-4000-8000-000000000001";

test("operational agent exposes an owner-scoped private context", async () => {
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), "agent-test", {
    workflowHost: () => ({ call: async () => ({ ok: false, status: 404, message: "not found" }) }),
  });
  const workflowHost = { organizationId: "org", installationId: app.installationId, userId: "alice", packageHash: "fixture", phase: "interactive" as const, expiresAt: Date.now() + 60_000 };
  try {
    const response = await app.call(`/api/apps/forerunner/agent/context?focus=${focus}`, member, { workflowHost });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { type: string; privateOnly: boolean; actions: unknown[] };
    assert.equal(body.type, "forerunner.conversation");
    assert.equal(body.privateOnly, true);
    assert.deepEqual(body.actions, []);
    const invalid = await app.call("/api/apps/forerunner/agent/context?focus=other", member, { workflowHost });
    assert.equal(invalid.status, 400);
    const anonymous = await app.call(`/api/apps/forerunner/agent/context?focus=${focus}`, undefined, { workflowHost });
    assert.equal(anonymous.status, 401);
    const types = await app.call("/api/internal/threads/v1/types", member, { method: "POST", body: {}, workflowHost });
    assert.equal(types.status, 200, await types.clone().text());
    const descriptors = await types.json() as { type: string; contexts: string[] }[];
    assert.equal(descriptors[0].type, "forerunner.conversation");
    assert.deepEqual(descriptors[0].contexts, ["forerunner.page"]);
  } finally { await app.dispose(); }
});
