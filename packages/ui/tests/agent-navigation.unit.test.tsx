import assert from "node:assert/strict";
import test from "node:test";
import { appEndpoint, appLocation, pageHref, requestedPage } from "../src/agent-navigation";

test("the page location is relative to the app's mount", () => {
  assert.equal(appLocation("/o/acme/wiki-map", { pathname: "/o/acme/wiki-map/organizations/1/knowledge-graphs", search: "?depth=2" }), "organizations/1/knowledge-graphs?depth=2");
  assert.equal(appLocation("", { pathname: "/", search: "" }), "");
});

test("a reply opens its last valid navigation, and only from its own submission", () => {
  const nav = (location: string) => ({ type: "data", name: "app.navigate", data: { location, label: "Page" } });
  const entries = [
    { submissionId: "older", parts: [nav("old")] },
    { submissionId: "this", parts: [{ type: "text" }, nav("first"), nav("https://evil.example/")] },
    { submissionId: "this", parts: [nav("second")] },
  ];
  assert.deepEqual(requestedPage(entries, "this"), { location: "second", label: "Page" });
  assert.equal(requestedPage(entries, "none"), undefined);
  assert.equal(requestedPage([{ submissionId: "x", parts: [nav("javascript:alert(1)")] }], "x"), undefined);
  assert.equal(requestedPage([{ submissionId: "x", status: "aborted", parts: [nav("stopped")] }], "x"), undefined);
});

test("page links stay under the app's mount", () => {
  const base = "https://outfitter.example/o/acme/wiki-map/organizations/1";
  assert.equal(pageHref("/o/acme/wiki-map", "organizations/1/knowledge-graphs?depth=2", base), "/o/acme/wiki-map/organizations/1/knowledge-graphs?depth=2");
  assert.equal(pageHref("/o/acme/wiki-map", "a/%2e%2e/%2e%2e/other-app", base), null);
  assert.equal(pageHref("", "organizations/1", "https://wiki.example/x"), "/organizations/1");
});


test("sidebar API endpoints use the same installation mount as thread requests", () => {
  const endpoint = "/api/apps/wiki-map/agent";
  for (const prefix of ["/apps/wiki-map", "/o/acme/wiki-map"]) {
    assert.equal(appEndpoint(prefix, endpoint), prefix + endpoint);
    assert.equal(appEndpoint(prefix, prefix + endpoint), prefix + endpoint);
    assert.equal(appEndpoint(prefix, "https://app.example/agent"), "https://app.example/agent");
    assert.equal(appEndpoint(prefix, "//app.example/agent"), "//app.example/agent");
    assert.equal(appEndpoint(prefix, "agent"), "agent");
  }
  assert.equal(appEndpoint("", endpoint), endpoint);
});
