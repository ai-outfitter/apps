import assert from "node:assert/strict";
import test from "node:test";
import { executeConnector } from "@ai-outfitter/connector-core/runtime";
import { googleCalendarConnector } from "../src/runtime";

test("bounded primary calendar reads require the selected account and credential", async () => {
  const prior = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url, init) => {
    requested = String(url);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer secret",
    );
    return Response.json({ items: [{ id: "event-1", summary: "Review" }] });
  };
  const connection = {
    id: "c",
    provider: "google-calendar",
    externalId: "account",
    owner: { kind: "user" as const, id: "alice" },
    status: "active" as const,
    config: { oauthClient: "connector" },
  };
  const context = {
    connection,
    scope: {
      organizationId: null,
      installationId: "app",
      userId: "alice",
      connectionId: "c",
      resource: "account",
      operations: ["events.list"],
    },
    credentials: { accessToken: "secret" },
  };
  const input = {
    calendarId: "primary",
    timeMin: "2026-10-29T00:00:00Z",
    timeMax: "2026-11-12T00:00:00Z",
    maxResults: 10,
  };
  const status = (code: number) => (e: unknown) =>
    e instanceof Response && e.status === code;
  try {
    assert.deepEqual(
      await executeConnector(
        googleCalendarConnector,
        "events.list",
        input,
        context,
      ),
      { items: [{ id: "event-1", summary: "Review" }] },
    );
    assert.match(requested, /calendars\/primary\/events/);
    assert.equal(new URL(requested).searchParams.get("timeMax"), input.timeMax);
    // A later page is read by its cursor.
    await executeConnector(googleCalendarConnector, "events.list", { ...input, cursor: "page-2" }, context);
    assert.equal(new URL(requested).searchParams.get("pageToken"), "page-2");
    await assert.rejects(
      executeConnector(googleCalendarConnector, "events.list", input, {
        ...context,
        scope: { ...context.scope, resource: "other" },
      }),
      status(403),
    );
    await assert.rejects(
      executeConnector(
        googleCalendarConnector,
        "events.list",
        { ...input, maxResults: 1000 },
        context,
      ),
      status(400),
    );
    await assert.rejects(
      executeConnector(googleCalendarConnector, "events.list", input, {
        ...context,
        credentials: {},
      }),
      status(503),
    );
    await assert.rejects(
      executeConnector(
        googleCalendarConnector,
        "events.list",
        { ...input, calendarId: "other" },
        context,
      ),
      status(400),
    );
  } finally {
    globalThis.fetch = prior;
  }
});
