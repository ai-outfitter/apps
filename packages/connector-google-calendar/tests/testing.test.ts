import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readCalendar } from "../src/index";
import { calendarFixtureTransport } from "../src/testing";

test("the fixture double serves only its synthetic calendars to the real adapter", async () => {
  const previous = globalThis.fetch;
  const event = { id: "evt-1", status: "confirmed" as const, start: "2026-09-21T15:00:00Z", end: "2026-09-21T16:00:00Z", attendees: [] };
  globalThis.fetch = calendarFixtureTransport("token-secret", { "team@example.com": [event] });
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T00:00:00Z") });
  try {
    const page = (await readCalendar("token-secret", { calendarId: "team@example.com" })) as { items: { id: string }[] };
    assert.deepEqual(page.items.map((item) => item.id), ["evt-1"]);
    await assert.rejects(readCalendar("token-secret", { calendarId: "other@example.com" }), (e: unknown) => e instanceof Response && e.status === 502);
    // The adapter reads upcoming events only; once the event has ended it is not returned.
    mock.timers.setTime(Date.parse("2026-09-21T16:00:00Z"));
    assert.deepEqual(await readCalendar("token-secret", { calendarId: "team@example.com" }), { items: [] });
  } finally {
    mock.timers.reset();
    globalThis.fetch = previous;
  }
});
