import assert from "node:assert/strict";
import { test } from "node:test";
import { secureId } from "../src/react/chat/secure-id";

test("uses the browser native UUID when available", () => {
  const native = "00000000-0000-4000-8000-000000000000" as const;
  assert.equal(secureId({ randomUUID: () => native, getRandomValues: () => { throw Error("unexpected fallback"); } }), native);
});

test("creates an RFC 4122 v4 ID from cryptographic random bytes when randomUUID is absent", () => {
  const id = secureId({ getRandomValues: (array) => { (array as Uint8Array).fill(255); return array; } });
  assert.equal(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});
