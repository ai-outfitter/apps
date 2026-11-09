import assert from "node:assert/strict";
import test from "node:test";
import { applyMergePatch, keyedChanges, keySet, patchKeySet, requireRevision, slugKeys, stateRevision } from "../src/merge-patch";

test("merge patch replaces values, removes nulls and adds new keys without changing its inputs", () => {
  const target = { title: "Gate", roles: { recommend: "cto", agree: { cfo: true } }, kinds: ["a"] };
  const patched = applyMergePatch(target, { title: "Work gate", roles: { agree: { cfo: null, coo: true } }, kinds: ["b"], extra: 1 });
  assert.deepEqual(patched, { title: "Work gate", roles: { recommend: "cto", agree: { coo: true } }, kinds: ["b"], extra: 1 });
  assert.deepEqual(target.roles.agree, { cfo: true });
});

test("keyed changes name each add, update and remove, and refuse removing what is not there", () => {
  const changes = keyedChanges({ a: 1, b: 2 }, { c: { x: 1 }, a: null, b: { y: 2 } });
  assert.deepEqual(changes, [
    { key: "a", change: "remove", before: 1 },
    { key: "b", change: "update", before: 2, patch: { y: 2 } },
    { key: "c", change: "add", patch: { x: 1 } },
  ]);
  assert.throws(() => keyedChanges({}, { gone: null }), (error: unknown) => error instanceof Response && error.status === 409);
});

test("state revisions follow content, not key order, and a stale one is refused", async () => {
  const one = await stateRevision({ a: 1, b: { c: [1, 2] } });
  assert.equal(one, await stateRevision({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(one, await stateRevision({ a: 1, b: { c: [2, 1] } }));
  requireRevision(one, one);
  assert.throws(() => requireRevision("old", one), (error: unknown) => error instanceof Response && error.status === 409);
});

test("slug keys prefer slugs, then titles, and fall back to ids when two records would share a key", () => {
  const keys = slugKeys(
    [
      { id: "3", title: "Chief Technology Officer", slug: "cto" },
      { id: "1", title: "Vega" },
      { id: "2", title: "Vega" },
      { id: "4", title: "Nicholas Romero" },
    ],
    (record) => record,
  );
  assert.deepEqual([...keys.keys()], ["1", "2", "cto", "nicholas-romero"]);
});

test("key sets add with true and remove with null", () => {
  assert.deepEqual(keySet(["b", "a"]), { a: true, b: true });
  assert.deepEqual(patchKeySet(["a", "b"], { a: null, c: true }), ["b", "c"]);
});
