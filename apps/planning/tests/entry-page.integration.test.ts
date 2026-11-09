import assert from "node:assert/strict";
import test from "node:test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { identityHeaderValues } from "@ai-outfitter/app-sdk/server";
import { appArtifact } from "@ai-outfitter/app-test/prepare";

const owner = { userId: "owner", organizationId: "org", role: "owner" };

test("entry preserves anonymous installation shell and personal project navigation", async () => {
  let hostCalls = 0;
  const app = await appWorker(
    "planning",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "planning",
    {
      workflowHost: () => ({
        async call() {
          hostCalls++;
          throw new Error("Anonymous entry must not call the data host");
        },
      }),
    },
  );
  try {
    const created = await app.call("/api/apps/planning/projects", owner, {
      method: "POST",
      body: { name: "Private project sentinel", goals: "Private goal sentinel" },
    });
    assert.equal(created.status, 200);
    const entry = await app.call("/");
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get("content-type") ?? "", /text\/html/);
    const html = await entry.text();
    assert.match(html, /Open Planning through your organization/);
    assert.doesNotMatch(html, /Private project sentinel|Private goal sentinel/);
    assert.match(html, /\/_astro\//);
    assert.equal(hostCalls, 0);
    for (const path of ["/api/apps/planning", "/api/apps/planning/product-graphs"])
      assert.equal(
        (await app.call(path, undefined, path.endsWith("product-graphs")
          ? { method: "POST", body: {} }
          : {})).status,
        401,
      );
    const personal = await app.dispatch("", new Request(`${app.origin}/`, {
      redirect: "manual",
      headers: identityHeaderValues({
        userId: "owner",
        installationId: "planning",
        role: "owner",
        owner: { kind: "user", id: "owner" },
      }),
    }), {
      workflowHost: {
        installationId: "planning",
        organizationId: null,
        userId: "owner",
        packageHash: "fixture",
        phase: "interactive",
        expiresAt: Date.now() + 3600000,
      },
    });
    assert.equal(personal.status, 302);
    assert.equal(personal.headers.get("location"), "/projects");
    assert.equal(hostCalls, 0, "personal entry does not request organization data");
    // A signed-in read with no scoped host remains a failure, not a public fallback.
    assert.equal((await app.call("/", owner)).status, 503);
  } finally {
    await app.dispose();
  }
});
