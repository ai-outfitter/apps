import assert from "node:assert/strict";
import test from "node:test";
import { brokerCredentials } from "../src/credential-bindings";
import { authenticatedBrokerBody, brokerClient } from "../src/broker";

const policy = {
  first: { "execute:records.read": { appKey: "FIRST_KEY" }, webhook: { signature: "FIRST_WEBHOOK" } },
  second: { "execute:records.read": { appKey: "SECOND_KEY" } },
};
const values: Record<string, string> = { FIRST_KEY: "first-key", FIRST_WEBHOOK: "first-signature", SECOND_KEY: "second-key" };
const call = { kind: "execute", provider: "first", operation: "records.read", credentials: {} };

test("credential binding lookup is scoped to provider and operation and survives signed broker transport", async () => {
  const lookups: string[] = [];
  const key = "a test-only broker key longer than thirty-two characters";
  let received: unknown;
  const client = brokerClient(async (request) => {
    received = await authenticatedBrokerBody(request, key);
    return Response.json({ ok: true });
  }, key, brokerCredentials(JSON.stringify(policy), (name) => { lookups.push(name); return values[name]; }));
  assert.deepEqual(await client(call), { ok: true });
  assert.deepEqual(received, { ...call, credentials: { appKey: "first-key" } });
  assert.deepEqual(lookups, ["FIRST_KEY"]);
  const resolve = brokerCredentials(policy, (name) => values[name]);
  assert.deepEqual(resolve({ kind: "webhook", provider: "first", credentials: {} }), { kind: "webhook", provider: "first", credentials: { signature: "first-signature" } });
  assert.deepEqual(resolve({ ...call, provider: "second" }), { ...call, provider: "second", credentials: { appKey: "second-key" } });
});

test("operator slots override supplied credentials while unconfigured identity calls do not receive app keys", () => {
  const resolve = brokerCredentials(policy, (name) => values[name]);
  assert.deepEqual(resolve({ ...call, credentials: { appKey: "override", accessToken: "control-plane-token" } }), { ...call, credentials: { appKey: "first-key", accessToken: "control-plane-token" } });
  const identity = { kind: "admit", provider: "first", operation: "identity.read", credentials: { accessToken: "member-token" } };
  assert.deepEqual(resolve(identity), identity);
  assert.deepEqual(resolve({ kind: "describe" }), { kind: "describe" });
});

test("invalid configuration or unavailable selected bindings fail closed without exposing configuration", async () => {
  for (const config of ["invalid sensitive configuration", { first: { "execute:records.read": { appKey: "invalid binding secret" } } }, policy]) {
    const resolve = brokerCredentials(config, () => undefined);
    let failure: unknown;
    try { resolve(call); } catch (error) { failure = error; }
    assert.ok(failure instanceof Response);
    assert.equal(failure.status, 503);
    assert.equal(await failure.text(), "Connector credentials unavailable");
  }
  assert.deepEqual(brokerCredentials(undefined, () => { throw new Error("unexpected lookup"); })(call), call);
});


test("connector-declared operation and slot names need no platform naming convention", () => {
  const body = { ...call, operation: "records_read:v2" };
  const resolve = brokerCredentials({ first: { "execute:records_read:v2": { "api-key": "customToken" } } }, () => "declared-secret");
  assert.deepEqual(resolve(body), { ...body, credentials: { "api-key": "declared-secret" } });
});
