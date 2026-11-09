import assert from "node:assert/strict";
import test from "node:test";
import { railNavigation } from "../src/rail-navigation";

test("an organization keeps all its primary destinations in the same organization", () => {
  const nav = railNavigation("https://outfitter.example", { name: "Sunny", href: "https://outfitter.example/o/sunny" });
  assert.equal(nav.label, "Sunny organization");
  assert.deepEqual(nav.links.map(link => link.href), ["", "/wiki", "/workflows", "/apps", "/settings"].map(path => `https://outfitter.example/o/sunny${path}`));
  assert.equal(nav.personalHref, "https://outfitter.example/");
});

test("personal navigation retains its own destinations", () => {
  const nav = railNavigation("https://outfitter.example");
  assert.equal(nav.label, "Personal");
  assert.equal(nav.personalHref, null);
  assert.deepEqual(nav.links.map(link => link.key), ["home", "for-you", "automations", "wiki", "organizations"]);
});

test("organization navigation refuses an external or ambiguous owner destination", () => {
  for (const href of ["https://evil.example/o/sunny", "https://outfitter.example/", "https://outfitter.example/o/sunny/onto", "https://outfitter.example/o/sunny?other=org"]) {
    assert.throws(() => railNavigation("https://outfitter.example", { name: "Sunny", href }));
  }
  assert.throws(() => railNavigation("https://user:secret@outfitter.example"));
});
