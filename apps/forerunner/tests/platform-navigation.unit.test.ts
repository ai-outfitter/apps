import assert from "node:assert/strict";
import test from "node:test";
import { platformHref } from "../src/platform-href";
test("platform management links keep personal, organization mount and app-host contexts", () => {
  for (const [url, expected] of [
    ["https://example.test/apps/forerunner/settings", "https://example.test/automations"],
    ["https://example.test/o/acme/forerunner/settings", "https://example.test/o/acme/automations"],
    ["https://forerunner.acme.example.test/settings", "https://example.test/o/acme/automations"],
  ]) assert.equal(platformHref(new Request("https://internal.test/settings", { headers: { "x-outfitter-page-url": url } }), "/automations"), expected);
});
