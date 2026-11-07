import assert from "node:assert/strict";
import test from "node:test";
import { appPreview } from "@ai-outfitter/server/preview";
import { platformPath, previewMode, previewPolicy } from "../scripts/preview.mjs";

const defined = <T>(value: T | null | undefined): T => {
  assert.ok(value !== null && value !== undefined);
  return value;
};

test("legacy browser run routes are not proxied", () => {
  assert.equal(platformPath("/workflow-runs", "GET"), false);
  assert.equal(platformPath("/workflow-runs/run-1", "GET"), false);
  assert.equal(platformPath("/api/workflow-runs/run-1", "GET"), true);
});

test("one Foundry preview switches fixtures and real APIs with server-side denial", async () => {
  let admin = 200;
  let apiCalls = 0;
  const platform = { fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/api/admin") return new Response(null, { status: admin });
    if (new URL(request.url).pathname === "/api/plugins/github") return Response.json({ connected: false });
    apiCalls++;
    return Response.json({ real: true });
  } };
  const app = { fetch: async () => new Response("<html><head></head><body>Foundry</body></html>", { headers: { "Content-Type": "text/html" } }) };
  const preview = appPreview(platform, app, "software-foundry", "sha", [], "https://test.ai-outfitter.dev", previewPolicy);
  const origin = "https://software-foundry-test.ai-outfitter.dev";
  const call = (path: string, init: RequestInit = {}) => preview.fetch(new Request(origin + path, init), { PREVIEW_INTERNAL: "true" }, {});
  const demo = await (await call("/governance")).text();
  assert.match(demo, /outfitter-platform-origin" content="https:\/\/test.ai-outfitter.dev"/);
  assert.match(demo, /outfitter-preview-mode" content="demo"/);
  assert.match(demo, /action="\/__preview\/mode"/);
  assert.equal((await call("/api/plugins/github/governance")).status, 404);
  assert.equal((await call("/api/workflow-runs", { method: "POST" })).status, 405);
  assert.equal((await call("/plugins/github", { method: "POST" })).status, 405);
  assert.equal(apiCalls, 0);
  assert.equal((await call("/__preview/mode", { method: "POST", body: new URLSearchParams({ mode: "operational" }) })).status, 403);
  const change = await call("/__preview/mode", { method: "POST", headers: { origin, referer: `${origin}/governance` }, body: new URLSearchParams({ mode: "operational" }) });
  assert.equal(change.status, 303);
  assert.equal(change.headers.get("location"), "/governance");
  assert.match(defined(change.headers.get("set-cookie")), /HttpOnly; SameSite=Lax; Secure/);
  const headers = { cookie: "outfitter-preview-mode=operational" };
  assert.deepEqual(await (await call("/api/plugins/github/governance", { headers })).json(), { real: true });
  assert.deepEqual(await (await call("/plugins/github", { method: "POST", headers })).json(), { real: true });
  assert.equal((await call("/api/admin/users", { headers })).status, 404);
  assert.match(await (await call("/governance", { headers })).text(), /content="operational"/);
  for (const path of ["/api/chats/run-1", "/api/workspaces/run-1", "/api/workspaces/run-1/download"])
    assert.deepEqual(await (await call(path, { headers })).json(), { real: true });
  assert.equal((await call("/api/workspaces/run-1/runs", { method: "POST", headers })).status, 405);
  admin = 403;
  assert.equal((await call("/api/plugins/github/governance", { headers })).status, 403);
  assert.equal((await call("/__preview/mode", { method: "POST", headers: { ...headers, origin }, body: new URLSearchParams({ mode: "operational" }) })).status, 403);
  assert.equal((await call("/plugins/github", { method: "POST", headers })).status, 403);
  assert.equal(apiCalls, 5);
});


test("Foundry preview forwards the resident identities feature read, not the removed route", () => {
  assert.equal(platformPath("/api/platform/features/resident-identities", "GET"), true);
  assert.equal(platformPath("/api/platform/features/resident-identities", "POST"), false);
  assert.equal(platformPath("/api/apps/resident-agent/execution-identities", "GET"), false);
});

test("Foundry defaults to available approved GitHub data and respects explicit choices", async () => {
  const request = (cookie?: string) => new Request("https://software-foundry-test.ai-outfitter.dev/", { headers: cookie ? { cookie } : {} });
  let probes = 0;
  let connected = true;
  let ready = "ready";
  let approved = ["ai-outfitter/webapp"];
  const platform = { fetch: async () => {
    probes++;
    return Response.json({ connected, repositoryAccess: true,
      repositories: [{ name: "ai-outfitter/webapp" }],
      scopes: [{ repositories: approved }],
      readiness: { "ai-outfitter/webapp": { status: ready } } });
  } };
  assert.equal(await previewMode(request(), platform, {}, {}), "operational");
  assert.equal(await previewMode(request("outfitter-preview-mode=demo"), platform, {}, {}), "demo");
  assert.equal(await previewMode(request("outfitter-preview-mode=operational"), platform, {}, {}), "operational");
  assert.equal(probes, 1);
  connected = false;
  assert.equal(await previewMode(request(), platform, {}, {}), "demo");
  connected = true;
  ready = "app-required";
  assert.equal(await previewMode(request(), platform, {}, {}), "demo");
  ready = "ready";
  approved = [];
  assert.equal(await previewMode(request(), platform, {}, {}), "demo");
  assert.equal(await previewMode(request(), { fetch: async () => new Response(null, { status: 403 }) }, {}, {}), "demo");
});

test("any app preview keeps real identity on the platform and returns private API auth failures", async () => {
  let adminStatus = 200;
  let identityStatus = 200;
  const paths: string[] = [];
  const platform = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/api/admin") return new Response(null, { status: adminStatus });
    assert.equal(path, "/api/whoami");
    assert.equal(request.headers.get("cookie"), "real-session");
    if (identityStatus !== 200) return new Response("Denied", { status: identityStatus, headers: { "Cache-Control": "private, no-store" } });
    return Response.json({ user: { name: "Real viewer" }, organization: null, installation: null }, { headers: { "Cache-Control": "private, no-store" } });
  } };
  const app = { async fetch() { throw new Error("Identity must never reach app Worker"); } };
  const request = () => new Request("https://html-preview.ai-outfitter.dev/api/whoami", { headers: { cookie: "real-session" } });
  for (const template of ["html-starter", "example-html"]) {
    const preview = appPreview(platform, app, template, "revision", [], "https://example.com");
    paths.length = 0;
    const response = await preview.fetch(request(), {}, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(await response.text(), /Real viewer/);
    assert.deepEqual(paths, ["/api/admin", "/api/whoami"]);
    for (const denial of [401, 403, 503]) {
      adminStatus = denial;
      const refused = await preview.fetch(request(), {}, {});
      assert.equal(refused.status, denial);
      assert.equal(refused.headers.get("cache-control"), "private, no-store");
      assert.equal(refused.headers.has("location"), false);
    }
    adminStatus = 200;
    for (const denial of [401, 403, 503]) {
      identityStatus = denial;
      const refused = await preview.fetch(request(), {}, {});
      assert.equal(refused.status, denial);
      assert.equal(refused.headers.get("cache-control"), "private, no-store");
    }
    identityStatus = 200;
    for (const path of ["/api/workflow-runs", "/api/platform/connectors/connection/issues.read", "/api/whoami/extra"])
      assert.equal((await preview.fetch(new Request(`https://html-preview.ai-outfitter.dev${path}`), {}, {})).status, 404);
    assert.equal((await preview.fetch(new Request("https://html-preview.ai-outfitter.dev/api/whoami", { method: "POST" }), {}, {})).status, 405);
  }
});
