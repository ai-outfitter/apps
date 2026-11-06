import assert from "node:assert/strict";
import test from "node:test";
import type { InstalledApp, RequestTenant } from "../src/hosts";
import {
  installedApp,
  isOperationalInstallation,
  requireInstalledApp,
} from "../src/installation";

const organization = { id: "org-1", name: "Acme", slug: "acme", logo: null };
const rootOrigin = "https://ai-outfitter.com";
const app = (
  template: string,
  mode: InstalledApp["mode"],
): InstalledApp => ({ id: `${template}-1`, script: `${template}-s1`, hash: "h1", template, mode });
const appHost = (installation: InstalledApp): RequestTenant => ({
  kind: "organization",
  rootOrigin,
  organization,
  installation,
});

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Response);
    return error.status;
  }
  assert.fail("expected a refusal");
}

test("an operational installation of the template passes", () => {
  const installation = app("workshop", "operational");
  const tenant = appHost(installation);
  assert.equal(installedApp(tenant, "workshop", { operational: true }), installation);
  assert.equal(requireInstalledApp(tenant, "workshop", { operational: true }), installation);
});

test("demo installations pass only when operational is not required", () => {
  const tenant = appHost(app("hr", "demo"));
  assert.equal(installedApp(tenant, "hr")?.id, "hr-1");
  assert.equal(installedApp(tenant, "hr", { operational: true }), null);
  assert.equal(refusal(() => requireInstalledApp(tenant, "hr", { operational: true })), 404);
});

test("an unclassified (null mode) installation is never operational", () => {
  const tenant = appHost(app("resident-agent", null));
  assert.equal(isOperationalInstallation({ mode: null }), false);
  assert.equal(isOperationalInstallation({}), false);
  assert.equal(installedApp(tenant, "resident-agent", { operational: true }), null);
  assert.equal(
    refusal(() => requireInstalledApp(tenant, "resident-agent", { operational: true })),
    404,
  );
});

test("another template's app host does not satisfy the guard", () => {
  const tenant = appHost(app("crm", "operational"));
  assert.equal(installedApp(tenant, "workshop", { operational: true }), null);
  assert.equal(refusal(() => requireInstalledApp(tenant, "workshop")), 404);
});

test("root, preview, organization and vanity hosts have no installation", () => {
  const tenants: RequestTenant[] = [
    { kind: "root", rootOrigin },
    { kind: "preview", rootOrigin },
    { kind: "organization", rootOrigin, organization },
    {
      kind: "organization",
      rootOrigin,
      organization,
      domain: { id: "d1", hostname: "app.acme.test", generation: 1 },
    },
  ];
  for (const tenant of tenants) {
    assert.equal(installedApp(tenant, "workshop", { operational: true }), null);
    assert.equal(refusal(() => requireInstalledApp(tenant, "workshop")), 404);
  }
});
