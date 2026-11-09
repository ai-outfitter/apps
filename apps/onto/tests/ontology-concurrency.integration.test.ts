import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { appWorker } from "@ai-outfitter/app-test/worker";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { nodeInput, edgeInput, typeInput } from "../src/lib/graph";
import { getNode, getType, saveNode, saveEdge, saveType } from "../src/server/graph";
type D1Database = Parameters<typeof drizzle>[0];
type D1PreparedStatement = ReturnType<D1Database["prepare"]>;

function beforeExecution(statement: D1PreparedStatement, before: () => Promise<void>): D1PreparedStatement {
  const execute = async (key: string, args: unknown[]) => {
    await before();
    return Reflect.apply(Reflect.get(statement, key), statement, args);
  };
  return new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...values: unknown[]) => beforeExecution(target.bind(...values), before);
    if (key === "all" || key === "run" || key === "raw") return (...args: unknown[]) => execute(key, args);
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("node, edge and definition saves guard the graph they read", async () => {
  const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
  const client = app.database;
  const who: AppIdentity = { userId: "owner", installationId: app.installationId, owner: { kind: "user", id: "owner" }, role: "owner", canEdit: true };
  const base = drizzle(client);
  const entityTypeId=crypto.randomUUID(), edgeTypeId=crypto.randomUUID();
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  try {
    await saveType(base, who, typeInput.parse({id:entityTypeId,name:"RaceFixtureEntity",category:"node",title:"Race fixture",body:"Uncontracted synthetic type for concurrency checks."}));
    await saveType(base, who, typeInput.parse({id:edgeTypeId,name:"RaceFixtureRelationship",category:"edge",ontology:{version:2,endpoints:{from:"any",to:"any"}},title:"Race fixture relationship",body:"Uncontracted synthetic type for concurrency checks."}));
    for (const [index, id] of ids.entries()) await saveNode(base, who, { verifiedReferences: true }, nodeInput.parse({ id, typeId: entityTypeId, title: `Race ${index}` }), []);
    function raced(table: string, changeDefinition: boolean | "endpoint" = false) {
      let fired = false;
      const before = async () => {
          if (!fired) {
            fired = true;
            if (changeDefinition === "endpoint") {
              await client.prepare("UPDATE graph_nodes SET archived=1, revision=revision+1 WHERE id=?").bind(ids[0]).run();
              return;
            }
            await client.prepare(changeDefinition ? "UPDATE graph_types SET revision=revision+1 WHERE id=?" : "UPDATE graph_nodes SET revision=revision+1 WHERE id=?").bind(changeDefinition ? entityTypeId : ids[2]).run();
          }
      };
      return drizzle({ prepare: (query: string) => {
        const statement = client.prepare(query);
        return new RegExp(`^(insert into|update) "${table}"`, "i").test(query) ? beforeExecution(statement, before) : statement;
      }, batch: client.batch.bind(client) } as unknown as D1Database);
    }
    const current = await getNode(base, ids[0]);
    // Every edge type declares its ends ("any" reaches every node), so saves guard the graph they read.
    await assert.rejects(saveNode(raced("graph_nodes"), who, { verifiedReferences: true }, nodeInput.parse({ id: current.id, typeId: current.typeId, title: "Refused after a concurrent edit" }), [], current, current.revision), (error: unknown) => error instanceof Response && error.status === 409);
    await assert.rejects(saveEdge(raced("graph_edges"), who, edgeInput.parse({ typeId: edgeTypeId, fromId: ids[0], toId: ids[1] })), (error: unknown) => error instanceof Response && error.status === 409);
    const edge = await saveEdge(base, who, edgeInput.parse({ typeId: edgeTypeId, fromId: ids[0], toId: ids[1] }));
    assert.equal(edge.fromId, ids[0]);
    await assert.rejects(saveType(raced("graph_types"), who, typeInput.parse({ name: "ConcurrentType", category: "node", title: "Concurrent", body: "Synthetic" })), (error: unknown) => error instanceof Response && error.status === 409);
    await assert.rejects(saveNode(raced("graph_nodes", true), who, { verifiedReferences: true }, nodeInput.parse({ typeId: entityTypeId, title: "Must roll back" }), []), (error: unknown) => error instanceof Response && error.status === 409);
    await assert.rejects(saveType(raced("graph_types", true), who, typeInput.parse({ name: "MustNotExist", category: "node", title: "Stale type", body: "Synthetic" })), (error: unknown) => error instanceof Response && error.status === 409);
    assert.equal(await client.prepare("SELECT id FROM graph_types WHERE name='MustNotExist'").first(), null);
    const currentType = await saveType(base, who, typeInput.parse({ name: "ContractActivationRace", category: "edge", ontology: { version: 2, endpoints: { from: "any", to: "any" } }, title: "Activation race", body: "Synthetic" }));
    await saveEdge(base, who, edgeInput.parse({ typeId: currentType.id, fromId: ids[0], toId: ids[1] }));
    const attributes = typeInput.parse(Object.fromEntries(Object.entries(currentType).filter(([key]) => key in typeInput.shape)));
    await assert.rejects(saveType(raced("graph_types", "endpoint"), who, {
      ...attributes, ontology: { version: 1, endpoints: { from: [entityTypeId], to: [entityTypeId] } },
    }, currentType, currentType.revision), (error: unknown) => error instanceof Response && error.status === 409);
    assert.deepEqual(((await getType(base, currentType.id)) as { ontology?: unknown }).ontology, { version: 2, endpoints: { from: "any", to: "any" } });
  } finally { await app.dispose(); }
});
