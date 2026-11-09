import assert from "node:assert/strict";
import test from "node:test";
import { appHref } from "../src/app-href";

// The app sees its own path; the browser may be under /apps/<slug>/ or /o/<org>/planning/.
test("app links resolve inside every mount", () => {
  for (const mount of ["https://site.example", "https://site.example/apps/planning", "https://site.example/o/acme/planning"])
    for (const [page, target, expected] of [
      ["/", "/products", "/products"],
      ["/projects", "/products", "/products"],
      ["/projects/p1", "/products", "/products"],
      ["/products/a/revisions/b", "/projects/p1/work", "/projects/p1/work"],
      ["/projects/p1", "/", "/"],
    ]) {
      const href = appHref(page, target);
      assert.ok(!href.startsWith("/"), href);
      assert.equal(new URL(href, `${mount}${page}`).pathname, `${new URL(mount).pathname.replace(/\/$/, "")}${expected}`);
    }
  assert.equal(appHref("/projects", "https://wiki.example/x"), "https://wiki.example/x");
  // Another app's platform address stays as it is.
  assert.equal(appHref("/projects/p1", "/apps/wiki/products/x"), "/apps/wiki/products/x");
  assert.equal(appHref("/projects/p1", "/o/acme/wiki-map/"), "/o/acme/wiki-map/");
});
