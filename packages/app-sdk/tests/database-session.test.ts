import assert from "node:assert/strict";
import test from "node:test";
import { requestDatabase, withDatabaseSession } from "../src/cloudflare/database-session";

test("D1 requests share a first-primary session and isolate concurrent requests", async () => {
  const created: unknown[] = [];
  const binding = { withSession(constraint: string) {
    assert.equal(constraint, "first-primary");
    const session = { id: created.length };
    created.push(session);
    return session;
  } } as unknown as D1Database;
  assert.equal(requestDatabase(binding), binding, "jobs outside a request use the primary binding");
  await Promise.all([1, 2].map(() => withDatabaseSession(binding, async () => {
    const session = requestDatabase(binding);
    assert.notEqual(session, binding);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(requestDatabase(binding), session, "async calls reuse this request's session");
    assert.equal(requestDatabase({} as D1Database) === session, false, "another binding never borrows its session");
  })));
  assert.equal(created.length, 2);
  assert.notEqual(created[0], created[1]);
  assert.equal(requestDatabase(binding), binding);
  assert.equal(withDatabaseSession(undefined, () => requestDatabase(undefined)), undefined);
});
