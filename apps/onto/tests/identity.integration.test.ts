import assert from "node:assert/strict";
import test from "node:test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { core } from "../src/lib/graph";

const owner = { userId: "owner", organizationId: "org", role: "owner" };
const identity = "/api/internal/identity/v1/";
const entities = "/api/internal/entities/v1/";

test("an Outfitter account is an OutfitterUser node joined to its holder by account_of", async () => {
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  const call = async (path: string, body: object, status = 200) => {
    const response = await app.call(path, owner, { method: "POST", body });
    assert.equal(response.status, status, await response.clone().text());
    return status === 200 ? response.json() : response.text();
  };
  try {
    await call("/api/internal/app-initialize", {});
    const person = (title: string) => call(entities + "create", { type: "graph-node", attributes: { typeId: core.person, title } });
    const ada = await person("Ada");
    const bea = await person("Bea");
    await call(identity + "link", { holderId: ada.ref.id, principalId: "user-1", kind: "human" });
    await call(identity + "link", { holderId: ada.ref.id, principalId: "user-1", kind: "human" });
    assert.deepEqual(await call(identity + "list", {}), [{ id: ada.ref.id, holderId: ada.ref.id, principalId: "user-1", kind: "human" }]);
    assert.deepEqual(await call(identity + "resolve", { principalId: "user-1" }), { holderId: ada.ref.id, principalId: "user-1", kind: "human" });
    assert.equal(await call(identity + "resolve", { principalId: "user-2" }), null);

    const accounts = await app.database.prepare("SELECT n.slug, n.externalKey FROM graph_nodes n JOIN graph_types t ON t.id = n.typeId WHERE t.name = 'OutfitterUser'").all();
    assert.deepEqual(accounts.results, [{ slug: "ada", externalKey: "ai-outfitter.com/users:user-1" }]);

    // Moving the account to Bea archives Ada's link; the account node stays.
    await call(identity + "link", { holderId: bea.ref.id, principalId: "user-1", kind: "human" });
    assert.deepEqual((await call(identity + "list", {})).map((row: { holderId: string }) => row.holderId), [bea.ref.id]);
    const links = await app.database.prepare("SELECT e.archived FROM graph_edges e JOIN graph_types t ON t.id = e.typeId WHERE t.name = 'account_of' ORDER BY e.archived").all();
    assert.deepEqual(links.results, [{ archived: 0 }, { archived: 1 }]);

    // A Person is not an agent, and an account key is never public.
    await call(identity + "link", { holderId: bea.ref.id, principalId: "agent-1", kind: "agent" }, 409);
    const listed = await call(entities + "list", { type: "graph-node", filter: { typeId: "71000000-0000-4000-8000-000000000120" } });
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes("ai-outfitter.com/users:"), false);

    await call(identity + "unlink", { holderId: bea.ref.id });
    assert.deepEqual(await call(identity + "list", {}), []);
  } finally {
    await app.dispose();
  }
});
