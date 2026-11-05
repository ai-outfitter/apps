import { RECURRING_TASK_WORKFLOW_ID, type RecurringTaskSample } from "./types";

// How the `collect` step's `sample` is filled from the connectors it declares
// (`mail`, `calendar`). The platform runs this before the assistant step with
// readers bound to the run owner's own read-only grants: it holds the tokens,
// leaves out quiet mail categories, and the rows it hands over are already
// flat text without data markers, so this only bounds their length. It writes
// the result to the step's connector output. A connector without a reader, or
// a failed or slow read, is recorded in `unavailable`, so the written result
// says what it could not read.

type Settings = { lookbackDays: number; messageLimit: number; eventLimit: number };
// The row fields this package reads; the platform's rows carry more.
type MailRow = { id: string; from: string; subject: string; date: string; receivedAt: string; snippet: string };
type EventRow = { id: string; title: string; start: string; recurring: boolean; attendees: number };

/** Readers for the connectors the step declares; absent when the owner has none active. */
export type RecurringTaskReaders = {
  mail?: (options: { days: number; limit: number; signal: AbortSignal }) => Promise<MailRow[]>;
  calendar?: (options: { days: number; limit: number; signal: AbortSignal }) => Promise<EventRow[]>;
};

/** Each read gets its own budget; a slow source is recorded as unavailable. */
export const SAMPLE_TIMEOUT_MS = 10_000;

type Source = "gmail" | "google-calendar";

/** One source's read, bounded; a failure is logged by source and reported, never thrown. */
async function read<T>(source: Source, work: ((signal: AbortSignal) => Promise<T>) | undefined) {
  if (!work) return null;
  // The signal cancels the provider requests; the race also bounds the
  // platform's grant lookup and token refresh, which the signal does not reach.
  const signal = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
  let onAbort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), deadline]);
  } catch (error) {
    console.warn("Recurring task read failed", {
      source,
      ...(error instanceof Response ? { status: error.status } : { error: String(error).slice(0, 300) }),
    });
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const mailSample = (m: MailRow) => ({
  id: m.id,
  from: m.from.slice(0, 120),
  subject: m.subject.slice(0, 160),
  date: m.receivedAt ? m.receivedAt.slice(0, 10) : m.date.slice(0, 40),
  snippet: m.snippet.slice(0, 240),
});

const eventSample = (e: EventRow, i: number) => ({
  id: e.id || `event-${i}`,
  title: e.title.slice(0, 160),
  start: e.start.slice(0, 25),
  recurring: e.recurring,
  attendees: e.attendees,
});

/** The owner's recent mail and upcoming events, each source on its own. */
export async function collectSample(settings: Settings, readers: RecurringTaskReaders): Promise<RecurringTaskSample> {
  const { mail, calendar } = readers;
  const days = settings.lookbackDays;
  const [messages, events] = await Promise.all([
    read("gmail", mail && ((signal) => mail({ days, limit: settings.messageLimit, signal }))),
    read("google-calendar", calendar && ((signal) => calendar({ days, limit: settings.eventLimit, signal }))),
  ]);
  const unavailable: Source[] = [];
  if (!messages) unavailable.push("gmail");
  if (!events) unavailable.push("google-calendar");
  return {
    connected: Boolean(messages || events),
    readAt: new Date().toISOString(),
    messages: (messages ?? []).map(mailSample),
    events: (events ?? []).map(eventSample),
    unavailable,
  };
}

/** What the platform needs to fill this workflow's connector-observed step. */
export const recurringTaskCollector = {
  workflowId: RECURRING_TASK_WORKFLOW_ID,
  collect: (inputs: Record<string, unknown>, readers: RecurringTaskReaders) =>
    collectSample(inputs.settings as Settings, readers),
};
