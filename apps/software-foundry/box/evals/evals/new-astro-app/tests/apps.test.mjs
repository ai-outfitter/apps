// Every app under apps/ has a valid manifest and package, builds its demo
// package with the SDK's builder and passes its unit tests. Browser tests are
// left out: the box's checks have no Chromium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const apps = readdirSync(join(root, "apps")).filter((name) => existsSync(join(root, "apps", name, "app.json")));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
// Without NODE_TEST_CONTEXT, an app's own node --test runs its files instead of skipping them.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const npm = (...args) => execFileSync("npm", args, { cwd: root, env, stdio: "inherit" });

for (const app of apps) {
  const directory = join(root, "apps", app);
  const pkg = json(join(directory, "package.json"));
  test(`${app}: manifest and package`, () => {
    const manifest = json(join(directory, "app.json"));
    assert.match(manifest.id, /^outfitter\/[a-z0-9-]+$/);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.modes?.demo, "declares a demo mode");
    assert.equal(pkg.outfitter?.kind, "app");
    assert.equal(pkg.version, manifest.version, "package and manifest versions match");
    for (const script of ["build", "check", "test"]) assert.ok(pkg.scripts?.[script], `has a ${script} script`);
  });
  test(`${app}: demo build and unit tests`, () => {
    npm("run", "--workspace", `apps/${app}`, "build");
    assert.ok(existsSync(join(directory, ".outfitter/packages/demo.json")), "wrote the demo package");
    if (pkg.scripts["test:unit"]) npm("run", "--workspace", `apps/${app}`, "test:unit");
  });
}
