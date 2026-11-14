import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerInventory,
  captureArchive,
} from "../scripts/audit-wiki-cutover.mjs";
const identity = { user: { id: "me" } };
const app = {
  installationId: "wiki",
  template: "wiki-map",
  organizationId: null,
  owner: { kind: "user", id: "me" },
};
test("inventory includes empty organizations and never treats provisioning as migration", () => {
  const rows = ownerInventory(identity, [{ id: "org", slug: "sunny" }], [app]);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.blockers.includes("onto-not-provisioned") &&
        row.blockers.includes("migration-not-verified"),
    ),
  );
});
test("cross-owner and ambiguous installation inventories cannot select a destination", () => {
  assert.throws(
    () => ownerInventory(identity, [], [{ ...app, organizationId: "other" }]),
    /does not match/,
  );
  assert.throws(
    () =>
      ownerInventory(
        identity,
        [],
        [{ ...app, owner: { kind: "user", id: "other" } }],
      ),
    /outside/,
  );
  const [row] = ownerInventory(
    identity,
    [],
    [app, { ...app, installationId: "wiki2" }],
  );
  assert.ok(row.blockers.includes("ambiguous-source"));
});
test("archive capture follows every cursor and binds every page to its owner", async () => {
  const urls: string[] = [];
  const pages = await captureArchive(
    async (url: string) => {
      urls.push(url);
      return {
        installationId: "wiki",
        organizationId: null,
        archive: {
          source: { installationId: "wiki", owner: { kind: "user", id: "me" } },
          cursor: urls.length === 1 ? "page2" : null,
        },
      };
    },
    app,
    async (_page: unknown, index: number) => index,
  );
  assert.deepEqual(pages, [0, 1]);
  assert.match(urls[1], /cursor=page2/);
  await assert.rejects(
    () =>
      captureArchive(
        async () => ({
          installationId: "other",
          archive: {
            source: {
              installationId: "wiki",
              owner: { kind: "user", id: "me" },
            },
            cursor: null,
          },
        }),
        app,
        async () => null,
      ),
    /mismatch/,
  );
});
test("repeated cursors and missing completeness metadata cannot look like a full archive", async () => {
  await assert.rejects(
    () =>
      captureArchive(
        async () => ({
          installationId: "wiki",
          archive: {
            source: {
              installationId: "wiki",
              owner: { kind: "user", id: "me" },
            },
            cursor: "same",
          },
        }),
        app,
        async () => null,
      ),
    /did not complete/,
  );
  await assert.rejects(
    () =>
      captureArchive(
        async () => ({
          installationId: "wiki",
          archive: {
            source: {
              installationId: "wiki",
              owner: { kind: "user", id: "me" },
            },
          },
        }),
        app,
        async () => null,
      ),
    /completeness cursor/,
  );
});

test("an archive with a foreign source owner is refused", async () => {
  await assert.rejects(
    () =>
      captureArchive(
        async () => ({
          installationId: "wiki",
          archive: {
            source: {
              installationId: "wiki",
              owner: { kind: "user", id: "other" },
            },
            cursor: null,
          },
        }),
        app,
        async () => null,
      ),
    /source lineage/,
  );
});
