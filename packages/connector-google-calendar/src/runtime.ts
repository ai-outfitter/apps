import { z } from "zod";
import { connectorManifestSchema } from "@ai-outfitter/connector-core/manifest";
import type { RuntimeConnector } from "@ai-outfitter/connector-core/runtime";
import { readCalendar } from "./index";

const input = z
  .strictObject({
    calendarId: z.string().min(1).max(254).default("primary"),
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
    maxResults: z.number().int().min(1).max(25).default(10),
    /** The `nextPageToken` of a previous page. */
    cursor: z.string().min(1).max(1024).optional(),
  })
  .refine(
    (v) => Date.parse(v.timeMin) < Date.parse(v.timeMax),
    "Choose an increasing time window",
  );

export const googleCalendarConnector = {
  descriptor: connectorManifestSchema.parse({
    schemaVersion: 1,
    id: "google-calendar",
    displayName: "Google Calendar",
    implementationVersion: "0.1.0",
    contractVersion: "connector.runtime.v1",
    operations: ["events.list"],
    authentication: { type: "oauth2", ownership: "user" },
  }),
  connectionCredential: "oauth2-access-token",
  config: z.object({ oauthClient: z.enum(["connector", "sign-in"]) }),
  events: {},
  verifyWebhook: null,
  async coversResource(connection, resource) {
    return (
      connection.provider === "google-calendar" &&
      connection.status === "active" &&
      connection.externalId === resource
    );
  },
  operations: {
    "events.list": {
      input,
      async execute(raw, context) {
        if (!context.credentials.accessToken)
          throw new Response("Calendar credential unavailable", {
            status: 503,
          });
        const value = input.parse(raw);
        // The first manual collector is deliberately limited to the primary calendar.
        if (value.calendarId !== "primary")
          throw new Response("Only the primary calendar is supported", {
            status: 400,
          });
        return readCalendar(context.credentials.accessToken, value);
      },
    },
  },
} satisfies RuntimeConnector;
