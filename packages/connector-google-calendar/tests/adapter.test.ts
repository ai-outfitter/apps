import test from "node:test";
import assert from "node:assert/strict";
import { readCalendar } from "../src/index";
test("read request stays on Google and sends credentials only in headers", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\//);
    assert.ok(!String(url).includes("token-secret"));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer token-secret",
    );
    assert.equal(init?.redirect, "manual");
    return Response.json({ items: [] });
  };
  try {
    assert.throws(
      () => readCalendar("token-secret", { calendarId: ".." }),
      (e: unknown) => e instanceof Response && e.status === 400,
    );
    assert.deepEqual(
      await readCalendar("token-secret", { calendarId: "team@example.com" }),
      { items: [] },
    );
  } finally {
    globalThis.fetch = previous;
  }
});
