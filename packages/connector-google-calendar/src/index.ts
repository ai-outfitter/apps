import { googleJson } from "@ai-outfitter/connector-google";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/";
/** The events collection of one calendar; an id that would leave the path is refused. */
function eventsUrl(calendarId: string) {
  if (!calendarId || calendarId === "." || calendarId === "..") throw new Response("Invalid calendar ID", { status: 400 });
  return new URL(`calendars/${encodeURIComponent(calendarId)}/events`, CALENDAR_API);
}
export function readCalendar(
  token: string,
  input: {
    calendarId?: string;
    cursor?: string;
    /** Free-text search over event fields. */
    query?: string;
    /** RFC 3339 bounds; events from now on when timeMin is omitted. */
    timeMin?: string;
    timeMax?: string;
    /** Most events or calendars listed (default 50). */
    maxResults?: number;
    /** Ends the request early, inside the connector's own timeout. */
    signal?: AbortSignal;
  },
) {
  const url = input.calendarId ? eventsUrl(input.calendarId) : new URL("users/me/calendarList", CALENDAR_API);
  url.searchParams.set("maxResults", String(input.maxResults ?? 50));
  if (input.cursor) url.searchParams.set("pageToken", input.cursor);
  if (input.calendarId) {
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", input.timeMin ?? new Date().toISOString());
    if (input.timeMax) url.searchParams.set("timeMax", input.timeMax);
    if (input.query) url.searchParams.set("q", input.query);
  }
  return googleJson(url.href, {
    headers: { Authorization: `Bearer ${token}` },
    signal: input.signal,
  });
}

export type UpcomingEventsOptions = {
  /** At most this many events, in start order. */
  limit: number;
  /** Only events starting within this many days of `timeMin` (or now). */
  days?: number;
  /** Defaults to the member's primary calendar. */
  calendarId?: string;
  /** RFC 3339 bounds; `timeMax` wins over `days`. */
  timeMin?: string;
  timeMax?: string;
  /** Free-text search over event fields. */
  query?: string;
  signal?: AbortSignal;
};

/**
 * One event as plain text. Titles and locations are provider text written by
 * other people, unclipped: framing it for a model is the caller's.
 */
export type EventRow = {
  id: string;
  title: string;
  /** RFC 3339 time, or a date for an all-day event. */
  start: string;
  end: string;
  location: string;
  recurring: boolean;
  organizer: string;
  /** How many people are invited. */
  attendees: number;
};

type CalendarEvent = {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  attendees?: unknown[];
  organizer?: { email?: string };
};

const DAY_MS = 86_400_000;

function windowEnd(options: UpcomingEventsOptions) {
  if (options.timeMax || !options.days) return options.timeMax;
  const from = options.timeMin ? Date.parse(options.timeMin) : Date.now();
  return new Date(from + options.days * DAY_MS).toISOString();
}

/** Upcoming events on one calendar, from now (or `timeMin`) on. */
export async function upcomingEvents(token: string, options: UpcomingEventsOptions): Promise<EventRow[]> {
  const list = (await readCalendar(token, {
    calendarId: options.calendarId ?? "primary",
    timeMin: options.timeMin,
    timeMax: windowEnd(options),
    query: options.query,
    maxResults: Math.max(1, options.limit),
    signal: options.signal,
  })) as { items?: CalendarEvent[] };
  return (list.items ?? []).slice(0, options.limit).map((e) => ({
    id: e.id ?? "",
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? "",
    recurring: Boolean(e.recurringEventId),
    organizer: e.organizer?.email ?? "",
    attendees: e.attendees?.length ?? 0,
  }));
}

/** An event to create on the member's calendar. */
export type EventInput = {
  title: string;
  /** RFC 3339 times, or `YYYY-MM-DD` dates for an all-day event; `end` is after `start`. */
  start: string;
  end: string;
  /** IANA zone the times are in; omitted, Google keeps the offset in the time. */
  timeZone?: string;
  description?: string;
  location?: string;
  /**
   * Guests, by email. They see the event on their own calendars at once, as
   * with any Google invitation; only the invitation email is withheld, so the
   * member can send it from Calendar when they are ready.
   */
  attendees?: string[];
  /** Defaults to the member's primary calendar. */
  calendarId?: string;
};

/** The created event: its id and where to open it in Google Calendar. */
export type CreatedEvent = { id: string; url: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
/** Whether a time needs `timeZone` to place it: a date-time written without an offset. */
export const needsTimeZone = (value: string) => !DATE.test(value) && !OFFSET.test(value);
const when = (value: string, timeZone?: string) =>
  DATE.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };

/**
 * Creates an event on the member's calendar (`calendar.events`). Only the
 * member's own action calls this; Google sends no invitation email for it.
 */
export async function createEvent(token: string, { calendarId = "primary", ...input }: EventInput): Promise<CreatedEvent> {
  const allDay = DATE.test(input.start);
  // An all-day event ends on the day after its last day, so a one-day event has end > start too.
  if (allDay !== DATE.test(input.end) || !(Date.parse(input.end) > Date.parse(input.start)))
    throw new Response("Invalid event times", { status: 400 });
  const url = eventsUrl(calendarId);
  url.searchParams.set("sendUpdates", "none");
  const event = (await googleJson(
    url.href,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: input.title,
        start: when(input.start, input.timeZone),
        end: when(input.end, input.timeZone),
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
      }),
    },
  )) as { id?: string; htmlLink?: string };
  if (!event.id) throw new Response("Google returned no event.", { status: 502 });
  return { id: event.id, url: event.htmlLink ?? `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(event.id)}` };
}
