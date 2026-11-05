import test from "node:test";
import assert from "node:assert/strict";
import { createEvent } from "../src/index";

test("an event is created on the primary calendar without invitations", async () => {
  const previous = globalThis.fetch;
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer token-secret",
    );
    assert.equal(init?.redirect, "manual");
    calls.push({
      url: new URL(String(url)),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      id: "e1",
      htmlLink: "https://www.google.com/calendar/event?eid=e1",
    });
  };
  try {
    const event = await createEvent("token-secret", {
      title: "Weekly check-in",
      start: "2026-10-20T09:00:00-05:00",
      end: "2026-10-20T09:30:00-05:00",
      timeZone: "America/Chicago",
      attendees: ["maria@example.com"],
      description: "Prep notes",
    });
    assert.deepEqual(event, {
      id: "e1",
      url: "https://www.google.com/calendar/event?eid=e1",
    });
    assert.equal(
      calls[0].url.pathname,
      "/calendar/v3/calendars/primary/events",
    );
    assert.equal(calls[0].url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(calls[0].body, {
      summary: "Weekly check-in",
      start: {
        dateTime: "2026-10-20T09:00:00-05:00",
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: "2026-10-20T09:30:00-05:00",
        timeZone: "America/Chicago",
      },
      description: "Prep notes",
      attendees: [{ email: "maria@example.com" }],
    });
    await createEvent("token-secret", {
      title: "Offsite",
      start: "2026-11-02",
      end: "2026-11-03",
      calendarId: "team@example.com",
    });
    assert.equal(
      calls[1].url.pathname,
      "/calendar/v3/calendars/team%40example.com/events",
    );
    assert.deepEqual(calls[1].body.start, { date: "2026-11-02" });
    await assert.rejects(
      () =>
        createEvent("token-secret", {
          title: "Mixed",
          start: "2026-11-02",
          end: "2026-11-02T10:00:00Z",
        }),
      (e: unknown) => e instanceof Response && e.status === 400,
    );
    await assert.rejects(
      () =>
        createEvent("token-secret", {
          title: "Dots",
          start: "2026-11-02",
          end: "2026-11-03",
          calendarId: "..",
        }),
      (e: unknown) => e instanceof Response && e.status === 400,
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = previous;
  }
});
