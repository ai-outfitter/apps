import { repositoryReadManifestSchema } from "../src/index";
import { brokerClient } from "../src/broker";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { executeConnector, validateDelivery, type ConnectorOperationContext, type RuntimeConnector } from "../src/runtime";

const context: ConnectorOperationContext = {
  connection: { id: "connection-a", provider: "fake", externalId: "external", owner: { kind: "organization", id: "org-a" }, status: "active", config: {} },
  scope: { organizationId: "org-a", installationId: "app-a", userId: null, connectionId: "connection-a", resource: "same-resource", operations: ["read"] },
  credentials: {},
};
function connector(covered: () => boolean): RuntimeConnector {
  return {
    descriptor: { schemaVersion: 1, id: "fake", displayName: "Fake", implementationVersion: "0.1.0", contractVersion: "connector.runtime.v1", operations: ["read"], authentication: { type: "access-token", ownership: "organization" } },
    config: z.object({}).strict(), events: { "fake.changed": z.object({ revision: z.number() }).strict() },
    verifyWebhook: async () => ({ deliveryId: "delivery", externalAccountId: "external", events: [] }),
    coversResource: async () => covered(),
    operations: { read: { input: z.object({}).strict(), execute: async (_input, ctx) => ctx.scope.resource } },
  };
}

test("resource strings cannot cross connections, providers or organization grants; coverage is rechecked", async () => {
  let covered = true;
  let probes = 0;
  const runtime = connector(() => { probes++; return covered; });
  assert.equal(await executeConnector(runtime, "read", {}, context), "same-resource");
  for (const scope of [
    { ...context.scope, connectionId: "connection-b" },
    { ...context.scope, organizationId: "org-b" },
    { ...context.scope, operations: ["write"] },
  ]) await assert.rejects(executeConnector(runtime, "read", {}, { ...context, scope }), (error: unknown) => error instanceof Response && error.status === 403);
  for (const connection of [
    { ...context.connection, provider: "other" },
    { ...context.connection, status: "revoked" as const },
    { ...context.connection, owner: { kind: "user" as const, id: "other-grantor" } },
  ]) await assert.rejects(executeConnector(runtime, "read", {}, { ...context, connection }), (error: unknown) => error instanceof Response && error.status === 403);
  assert.equal(probes, 1);
  covered = false;
  await assert.rejects(executeConnector(runtime, "read", {}, context), (error: unknown) => error instanceof Response && error.status === 403);
  assert.equal(probes, 2);
});

test("event vocabulary and payload validation belong to the connector declaration", () => {
  const runtime = connector(() => true);
  const delivery = { deliveryId: "delivery", externalAccountId: "external", events: [{ type: "fake.changed", resource: "same-resource", subject: "1", payload: { revision: 2 } }] };
  assert.deepEqual(validateDelivery(runtime, delivery), delivery);
  assert.throws(() => validateDelivery(runtime, { ...delivery, events: [{ ...delivery.events[0], type: "other.changed" }] }), /undeclared event/);
  assert.throws(() => validateDelivery(runtime, { ...delivery, events: [{ ...delivery.events[0], payload: { revision: "2" } }] }));
});


test("broker transport failures retry while explicit coverage denial remains forbidden", async () => {
  for (const [upstream, expected] of [[401, 503], [404, 503], [403, 403], [422, 422], [500, 500]]) {
    const call = brokerClient(async () => new Response("upstream", { status: upstream }), "a".repeat(32));
    await assert.rejects(call({ kind: "describe" }), (error: unknown) => error instanceof Response && error.status === expected);
  }
});

test("narrowed connector contracts retain ownership policy refinements", () => {
  const descriptor = { ...connector(() => true).descriptor, contractVersion: "repository.read.v1",
    operations: ["repositories.verify", "issues.read", "pull-requests.read"],
    connection: { accountsPerOwner: "one", accountSharing: "exclusive" } };
  assert.equal(repositoryReadManifestSchema.safeParse(descriptor).success, true);
  const invalid = repositoryReadManifestSchema.safeParse({ ...descriptor,
    connection: { ...descriptor.connection, accountsPerOwner: "many" } });
  assert.equal(invalid.success, false);
  assert.ok(invalid.error?.issues.some((issue) => issue.message === "Multiple accounts currently require user ownership"));
});
