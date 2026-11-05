import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { upcomingEvents } from "../src/index";
import { calendarFixtureTransport } from "../src/testing";

const event = (id: string, start: string, extra: Record<string, string> = {}) => ({
  id,
  status: "confirmed" as const,
  start,
  end: new Date(Date.parse(start) + 3_600_000).toISOString(),
  attendees: [
    { email: "ana@example.com", responseStatus: "accepted" as const },
    { email: "ben@example.com", responseStatus: "needsAction" as const },
  ],
  ...extra,
});

test("upcoming events read the primary calendar within the window as plain rows", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = calendarFixtureTransport("token-secret", {
    primary: [
      event("evt-1", "2026-09-02T15:00:00.000Z", { summary: "Weekly planning", recurringEventId: "weekly" }),
      event("evt-2", "2026-09-03T15:00:00.000Z"),
      event("evt-3", "2026-09-20T15:00:00.000Z", { summary: "Far away" }),
    ],
  });
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-01T00:00:00Z") });
  try {
    assert.deepEqual(await upcomingEvents("token-secret", { days: 7, limit: 5 }), [
      {
        id: "evt-1",
        title: "Weekly planning",
        start: "2026-09-02T15:00:00.000Z",
        end: "2026-09-02T16:00:00.000Z",
        location: "",
        recurring: true,
        organizer: "",
        attendees: 2,
      },
      {
        id: "evt-2",
        title: "(no title)",
        start: "2026-09-03T15:00:00.000Z",
        end: "2026-09-03T16:00:00.000Z",
        location: "",
        recurring: false,
        organizer: "",
        attendees: 2,
      },
    ]);
    // Without a window every upcoming event counts, up to the limit.
    assert.deepEqual((await upcomingEvents("token-secret", { limit: 5 })).map((row) => row.id), ["evt-1", "evt-2", "evt-3"]);
    assert.deepEqual((await upcomingEvents("token-secret", { limit: 1 })).map((row) => row.id), ["evt-1"]);
    await assert.rejects(upcomingEvents("token-secret", { limit: 1, calendarId: "other@example.com" }), (e: unknown) => e instanceof Response && e.status === 502);
  } finally {
    mock.timers.reset();
    globalThis.fetch = previous;
  }
});

test("a caller's signal ends the read early", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const caller = new AbortController();
  const timer = setTimeout(() => caller.abort(new DOMException("budget spent", "TimeoutError")), 10);
  try {
    await assert.rejects(upcomingEvents("token-secret", { limit: 1, signal: caller.signal }), { name: "TimeoutError" });
    clearTimeout(timer);
  } finally {
    globalThis.fetch = previous;
  }
});

test("the list asks Google for only the limit", async () => {
  const previous = globalThis.fetch;
  const asked: (string | null)[] = [];
  globalThis.fetch = async (input) => {
    asked.push(new URL(String(input)).searchParams.get("maxResults"));
    return Response.json({ items: [] });
  };
  try {
    assert.deepEqual(await upcomingEvents("token-secret", { limit: 4 }), []);
    assert.deepEqual(asked, ["4"]);
  } finally {
    globalThis.fetch = previous;
  }
});
