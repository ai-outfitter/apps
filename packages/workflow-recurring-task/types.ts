/** Presentation types; runtime validation comes from workflow.yaml. */

/** The definition's `id` in workflow.yaml; the recurring-task test checks they agree. */
export const RECURRING_TASK_WORKFLOW_ID = "recurring-task";

export type RecurringTask = {
  title: string;
  description: string;
  cadence?: string;
  steps?: string[];
  evidence?: string;
};
export type RecurringTaskSample = {
  connected: boolean;
  readAt: string;
  messages: { id: string; from: string; subject: string; date: string; snippet: string }[];
  events: { id: string; title: string; start: string; recurring: boolean; attendees: number }[];
  unavailable: ("gmail" | "google-calendar")[];
};
/** An email an item carries, for the member to save to their Gmail drafts. */
export type ResultDraft = { to: string[]; subject: string; body: string };
/** A meeting or time block an item carries, for the member to add to their calendar. */
export type ResultEvent = { title: string; start: string; end: string; description?: string; attendees?: string[] };
export type ResultItem = { title: string; detail: string; draft?: ResultDraft; event?: ResultEvent };
export type RecurringTaskResult = {
  headline: string;
  body: string;
  items: ResultItem[];
  couldNotRead?: string;
};
