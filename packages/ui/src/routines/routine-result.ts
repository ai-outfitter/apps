import {
  RECURRING_TASK_WORKFLOW_ID,
  type RecurringTaskResult,
  type ResultDraft,
  type ResultEvent,
  type ResultItem,
} from "@ai-outfitter/workflow-recurring-task/types";
import { WRITE_SCOPE_NEEDED } from "@ai-outfitter/connector-google";
import { needsTimeZone } from "@ai-outfitter/connector-google-calendar";
import { z } from "zod";

// What a routine (a `recurring-task` run) wrote, read back from its slots for
// the run page, the routines list and the chat. The slot value was validated
// against the workflow schema when it was written; this parse only guards the
// readers against a run from an older definition.

/** The routine workflow, from its package's browser-safe types, without server modules. */
export { RECURRING_TASK_WORKFLOW_ID };

export const ROUTINE_RESULT_SLOT = "write.outputs.result";
export const ROUTINE_TASK_SLOT = "collect.inputs.task";
/** The member a run waits on; they finish it by copying or marking it completed. */
export const ROUTINE_OWNER_SLOT = "collect.inputs.owner";
export const ROUTINE_FINISH_STEP = "finish";

const draft = z.object({
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
});
const event = z.object({
  title: z.string(),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});
const item = z.object({
  title: z.string(),
  detail: z.string(),
  draft: draft.optional(),
  event: event.optional(),
});
export const routineResult = z.object({
  headline: z.string(),
  body: z.string(),
  items: z.array(item),
  couldNotRead: z.string().optional(),
});

/** The parsed result, or null when the slot is missing or not a result. */
export function routineResultOf(value: unknown): RecurringTaskResult | null {
  const parsed = routineResult.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The task title a routine run was started with, when its inputs carry one. */
export function routineTitleOf(inputs: Record<string, unknown>): string | null {
  const task = inputs[ROUTINE_TASK_SLOT];
  const title = task && typeof task === "object" ? (task as { title?: unknown }).title : undefined;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

/** An event as one line of text: title, when, and who. */
export const eventText = (event: ResultEvent) =>
  `${event.title} · ${event.start} to ${event.end}${event.attendees?.length ? ` · with ${event.attendees.join(", ")}` : ""}`;

/** A draft as the mail reads, set off by a blank line: its subject, then its body. */
const draftText = (draft: ResultDraft) => ["", `Subject: ${draft.subject}`, "", draft.body.trim()].join("\n");

/** An item as plain text: its line, then any event or draft it carries. */
export const itemText = (item: ResultItem) =>
  [
    item.detail ? `${item.title}: ${item.detail}` : item.title,
    ...(item.event ? [eventText(item.event)] : []),
    ...(item.draft ? [draftText(item.draft)] : []),
  ].join("\n");

/** The whole result as plain text, for the clipboard. */
export function routineResultText(result: RecurringTaskResult) {
  const parts = [result.headline];
  if (result.body.trim()) parts.push("", result.body.trim());
  if (result.items.length) parts.push("");
  result.items.forEach((entry, index) => {
    // A draft ends its item; the next item starts after a blank line.
    if (index && result.items[index - 1].draft) parts.push("");
    parts.push(itemText(entry));
  });
  if (result.couldNotRead) parts.push("", result.couldNotRead);
  return parts.join("\n");
}

/** Whether any item carries a draft or an event, so the page needs the member's writers. */
export function hasWrites(value: unknown) {
  return routineResultOf(value)?.items.some((entry) => entry.draft || entry.event) ?? false;
}

/** A written result the member has not yet copied or marked completed. */
export const waitingOnOwner = (status: string, hasResult: boolean) => status === "running" && hasResult;

/** How the member used a result: the finish step's `how`. */
export type RoutineFinish = "copied" | "marked" | "drafted" | "scheduled";

/**
 * A platform route as the URL the browser fetches. Platform pages use the path
 * itself; an app mounted under the platform passes one reaching the platform origin.
 */
export type PlatformURL = (path: string) => string;
export const samePath: PlatformURL = (path) => path;

/** A JSON POST from the page; rejects with the server's reason, or `fallback` when it gave none. */
async function postJSON(path: string, body: unknown, fallback: string, platformURL: PlatformURL) {
  const response = await fetch(platformURL(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.text()) || fallback);
  return response;
}

/** Finishes a run for its member through its finish step; rejects with the server's reason. */
export async function finishRoutineRun(runId: string, how: RoutineFinish, step: string, platformURL: PlatformURL = samePath) {
  await postJSON(
    `/api/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}`,
    { response: { completed: true, how } },
    "Could not mark it completed",
    platformURL,
  );
}

/**
 * The member's Google connections a result's buttons write with: one per
 * capability, with whether its grant allows the write. Absent, the button
 * offers to connect; `writes: false`, to allow the write.
 */
export type ResultWriters = {
  gmail?: { id: string; writes: boolean };
  calendar?: { id: string; writes: boolean };
};

/** The writers among the member's Google connections: the first active one per capability. */
export function resultWriters(connections: { id: string; provider: string; status: string; writes: boolean }[] | undefined): ResultWriters | undefined {
  if (!connections) return undefined;
  const first = (provider: string) => {
    const row = connections.find((item) => item.provider === provider && item.status === "active");
    return row ? { id: row.id, writes: row.writes } : undefined;
  };
  return { gmail: first("gmail"), calendar: first("google-calendar") };
}

/** The grant was given without the write scope: connecting again asks for it. */
export { WRITE_SCOPE_NEEDED };

const googleWrite = async (connectionId: string, kind: "drafts" | "events", body: unknown, platformURL: PlatformURL) =>
  (await postJSON(`/api/connectors/google/${encodeURIComponent(connectionId)}/${kind}`, body, "Google did not accept it", platformURL)).json() as Promise<{
    url: string;
  }>;

/**
 * The addresses in a model-written recipient list, as the route accepts them:
 * the address inside `Name <addr>`, bare addresses kept, anything else dropped
 * (the member adds recipients in Gmail or Calendar).
 */
export function addressesOf(list: string[]) {
  return list.flatMap((entry) => {
    const inner = /<([^<>\s]+@[^<>\s]+)>/.exec(entry)?.[1] ?? entry.trim();
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner) ? [inner] : [];
  });
}

/** Saves an item's draft to the member's Gmail; resolves with where to open it. */
export const saveDraft = (connectionId: string, draft: ResultDraft, platformURL: PlatformURL = samePath) =>
  googleWrite(connectionId, "drafts", { ...draft, to: addressesOf(draft.to) }, platformURL);

/**
 * Adds an item's event to the member's calendar; resolves with where to open
 * it. A time written without an offset is in the member's own zone.
 */
export const addEvent = (
  connectionId: string,
  event: ResultEvent,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  platformURL: PlatformURL = samePath,
) =>
  googleWrite(
    connectionId,
    "events",
    {
      ...event,
      ...(event.attendees ? { attendees: addressesOf(event.attendees) } : {}),
      ...(needsTimeZone(event.start) ? { timeZone } : {}),
    },
    platformURL,
  );

/**
 * What an item's write button does, from the item and the member's writers:
 * nothing (no draft or event), connect the capability, allow its write scope,
 * or write. The component only renders this.
 */
export type WriteCapability = "gmail" | "google-calendar";
export type WriteAction =
  | { kind: "connect" | "allow"; capability: WriteCapability; label: string }
  | {
      kind: "write";
      capability: WriteCapability;
      connectionId: string;
      label: string;
      done: string;
      how: RoutineFinish;
    };

/** What each capability's button says: to connect, to allow the write, to write, and once written. */
const WRITES: Record<
  WriteCapability,
  {
    connect: string;
    allow: string;
    label: string;
    done: string;
    how: RoutineFinish;
  }
> = {
  gmail: {
    connect: "Connect Gmail to save drafts",
    allow: "Allow Gmail drafts",
    label: "Save to Gmail drafts",
    done: "Open in Gmail",
    how: "drafted",
  },
  "google-calendar": {
    connect: "Connect Calendar to add events",
    allow: "Allow calendar events",
    label: "Add to calendar",
    done: "Open in Calendar",
    how: "scheduled",
  },
};

/** The button that asks Google for a capability's write scope. */
export const allowLabel = (capability: WriteCapability) => WRITES[capability].allow;

export function writeAction(item: ResultItem, writers: ResultWriters): WriteAction | null {
  if (!item.draft && !item.event) return null;
  const capability: WriteCapability = item.draft ? "gmail" : "google-calendar";
  const words = WRITES[capability];
  const connection = item.draft ? writers.gmail : writers.calendar;
  if (!connection) return { kind: "connect", capability, label: words.connect };
  if (!connection.writes) return { kind: "allow", capability, label: words.allow };
  return {
    kind: "write",
    capability,
    connectionId: connection.id,
    label: words.label,
    done: words.done,
    how: words.how,
  };
}
