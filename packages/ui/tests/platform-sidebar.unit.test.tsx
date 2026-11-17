import assert from "node:assert/strict";
import test from "node:test";
import { platformSidebar } from "../src/platform-sidebar";
import { sidebarThreadId } from "@ai-outfitter/app-sdk/threads";

const request = (organization: string | null, endpoint: string) => new Request("https://app.invalid/", { headers: {
  "x-outfitter-sidebar-base": endpoint,
  "x-outfitter-user": "member", "x-outfitter-installation": "app", "x-outfitter-role": "member",
  "x-outfitter-owner": organization ? `organization:${organization}` : "user:member",
  ...(organization ? { "x-outfitter-organization": organization } : {}),
} });
test("managed shells use the platform's member/owner thread, independent of installation", async () => {
  for (const organizationId of [null, "org"] as const) {
    const endpoint = `https://example.test${organizationId ? "/o/team" : ""}/api/platform/threads`;
    const panel = await platformSidebar(request(organizationId, endpoint));
    assert.equal(panel?.thread.id, await sidebarThreadId({ userId: "member", organizationId }));
    assert.equal(panel?.endpoint, endpoint);
    assert.equal(panel?.scopeKey, organizationId ?? "personal");
  }
});
test("missing, malformed and foreign-member shell context does not enable the platform panel", async () => {
  assert.equal(await platformSidebar(new Request("https://app.invalid")), null);
  for (const endpoint of ["not a URL", "https://example.test/api/arbitrary", "javascript:alert(1)", "https://u:p@example.test/api/platform/threads"]) {
    assert.equal(await platformSidebar(request(null, endpoint)), null);
  }
  const external = request("org", "https://example.test/o/team/api/platform/threads");
  external.headers.set("x-outfitter-role", "external");
  external.headers.set("x-outfitter-caller-organization", "other");
  assert.equal(await platformSidebar(external), null);
});
