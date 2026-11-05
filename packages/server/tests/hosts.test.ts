import assert from "node:assert/strict";
import test from "node:test";
import {
  crossSubdomainCookieOptions,
  managedAppHostname,
  organizationOrigin,
  organizationOriginForAppHost,
  safeReturnPath,
  sharedCookieZone,
  validOrganizationSlug,
} from "../src/hosts";

test("organization and app hostnames derive from the root origin", () => {
  assert.equal(
    organizationOrigin("https://ai-outfitter.com", "acme"),
    "https://ai-outfitter.com/o/acme",
  );
  // Internal previews serve one organization on their own flat hostname.
  assert.equal(
    organizationOrigin("https://feat-x.ai-outfitter.dev", "acme"),
    "https://feat-x.ai-outfitter.dev/o/acme",
  );
  assert.equal(
    managedAppHostname("workshop", "acme", "https://ai-outfitter.com"),
    "workshop.acme.ai-outfitter.com",
  );
});

test("slugs, return paths and cookie zones reject what they must", () => {
  assert.equal(validOrganizationSlug("acme-labs"), true);
  for (const slug of ["app", "Acme", "-acme", "a".repeat(64)])
    assert.equal(validOrganizationSlug(slug), false);
  assert.equal(safeReturnPath("/c/1?x=2"), "/c/1?x=2");
  for (const path of ["//evil.test", "/\\evil", "https://evil.test", "c/1"])
    assert.equal(safeReturnPath(path), null);
  assert.equal(safeReturnPath("/auth/domain/start"), "/");
  assert.equal(sharedCookieZone("acme.ai-outfitter.com"), "ai-outfitter.com");
  assert.equal(sharedCookieZone("feat-x.ai-outfitter.dev"), undefined);
});

test("hosts.ts stays pure: only JSON data imports, no database, schema or webapp code", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/hosts.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\s.*\sfrom\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(specifiers.filter((s) => !/^\.\/[\w-]+\.json$/.test(s)), []);
});


const at = (url: string) => {
  const { protocol, hostname, port } = new URL(url);
  return { protocol, hostname, port };
};

test("an app host links to its organization on the same root", () => {
  assert.equal(
    organizationOriginForAppHost("workshop", at("https://workshop.acme.ai-outfitter.com/")),
    "https://ai-outfitter.com/o/acme",
  );
  assert.equal(
    organizationOriginForAppHost("hr", at("http://hr.alpha.localhost:4390/")),
    "http://localhost:4390/o/alpha",
  );
});

test("an internal preview app host links to the flat preview origin", () => {
  assert.equal(
    organizationOriginForAppHost("resident-agent", at("https://resident-agent.acme.feat-x.ai-outfitter.dev/")),
    "https://feat-x.ai-outfitter.dev/o/acme",
  );
});

test("a host that is not this template's app host has no link", () => {
  assert.equal(organizationOriginForAppHost("hr", at("https://acme.ai-outfitter.com/")), null);
  assert.equal(organizationOriginForAppHost("hr", at("https://hr.localhost/")), null);
});


test("explicit local development shares the seeded session only across its local app hosts", () => {
  const env = { BETTER_AUTH_URL: "http://outfitter.localhost:4390", OUTFITTER_LOCAL_DEV: "1" };
  assert.deepEqual(crossSubdomainCookieOptions(env), { enabled: true, domain: ".outfitter.localhost" });
  assert.equal(crossSubdomainCookieOptions({ ...env, NODE_ENV: "production" }), undefined);
  assert.equal(crossSubdomainCookieOptions({ BETTER_AUTH_URL: env.BETTER_AUTH_URL }), undefined);
  assert.equal(crossSubdomainCookieOptions({ ...env, BETTER_AUTH_URL: "http://example.com" }), undefined);
});
