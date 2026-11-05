/** Synthetic event served by the Calendar fixture double. */
export interface FixtureEvent {
  id: string;
  status: "confirmed" | "cancelled";
  start: string;
  end: string;
  attendees: { email: string; responseStatus: "needsAction" | "accepted" | "declined" | "tentative" }[];
  summary?: string;
  /** Set on each occurrence of a recurring event. */
  recurringEventId?: string;
}

const inWindow = (event: FixtureEvent, timeMin: string | null, timeMax: string | null) =>
  (!timeMin || Date.parse(event.end) > Date.parse(timeMin)) && (!timeMax || Date.parse(event.start) < Date.parse(timeMax));

/**
 * Fetch double for this connector's provider reads, keyed by calendar ID. Only event
 * lists of the given calendars are served; every other request answers 404. Like
 * Google, `timeMin` excludes events that ended at or before it and `timeMax` those
 * starting at or after it.
 */
export function calendarFixtureTransport(token: string, calendars: Record<string, FixtureEvent[]>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${token}` || url.href.includes(token))
      return new Response(null, { status: 401 });
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    const events = url.origin === "https://www.googleapis.com" && match ? calendars[decodeURIComponent(match[1])] : undefined;
    const timeMin = url.searchParams.get("timeMin");
    const timeMax = url.searchParams.get("timeMax");
    return events
      ? Response.json({
          items: events
            .filter((event) => inWindow(event, timeMin, timeMax))
            .map((event) => ({
              id: event.id,
              status: event.status,
              start: { dateTime: event.start },
              end: { dateTime: event.end },
              attendees: event.attendees,
              ...(event.summary === undefined ? {} : { summary: event.summary }),
              ...(event.recurringEventId === undefined ? {} : { recurringEventId: event.recurringEventId }),
            })),
        })
      : new Response(null, { status: 404 });
  };
}
