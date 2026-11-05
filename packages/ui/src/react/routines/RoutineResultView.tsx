import type { RecurringTaskResult, ResultItem } from "@ai-outfitter/workflow-recurring-task/types";
import { useEffect, useState } from "react";
import {
  addEvent,
  allowLabel,
  itemText,
  type ResultWriters,
  type RoutineFinish,
  routineResultText,
  saveDraft,
  WRITE_SCOPE_NEEDED,
  writeAction,
} from "../../routines/routine-result";
import { usePlatformURL } from "../chat/context";
import Markdown from "../Markdown";
import { type RoutineCompletion, useRunFinish } from "./use-run-finish";

// What a routine wrote, readable and copyable: the headline, the body as
// markdown, and each item with its own Copy button, so a drafted reply or a
// list of follow-ups can go straight into the member's mail client. An item
// that carries a draft or an event also has "Save to Gmail drafts" or "Add to
// calendar", which writes it with the member's own connection (`writers`) and
// finishes the run like a copy does; without the connection or its write
// scope the button connects Google, returning here. Given the run, the first
// copy or "Mark completed" finishes it; any run result shares these controls
// (RunResult).

/** The connect form a write button becomes when the member has no grant for it; consent returns to `returnTo`. */
function ConnectGoogle({ capability, label, returnTo }: { capability: "gmail" | "google-calendar"; label: string; returnTo?: string }) {
  const platformURL = usePlatformURL();
  return (
    <form method="post" action={platformURL("/api/connectors/google/authorize")} className="routine-write-connect">
      <input type="hidden" name="capability" value={capability} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <button type="submit" className="routine-write">
        {label}
      </button>
    </form>
  );
}

/**
 * Saves an item's draft to Gmail or adds its event to the calendar. One press
 * writes once; afterwards the button is a link to what was written.
 */
function WriteButton({
  item,
  writers,
  returnTo,
  onWritten,
}: {
  item: ResultItem;
  writers: ResultWriters;
  returnTo?: string;
  onWritten?: (how: RoutineFinish) => void;
}) {
  const [state, setState] = useState<{ status: "open" | "saving" } | { status: "written"; url: string } | { status: "failed"; reason: string }>({
    status: "open",
  });
  const platformURL = usePlatformURL();
  const { draft, event } = item;
  const action = writeAction(item, writers);
  if (!action) return null;
  if (action.kind !== "write") return <ConnectGoogle capability={action.capability} label={action.label} returnTo={returnTo} />;
  // The stored grant said it could write but Google disagreed: ask for the scope.
  if (state.status === "failed" && state.reason === WRITE_SCOPE_NEEDED)
    return <ConnectGoogle capability={action.capability} label={allowLabel(action.capability)} returnTo={returnTo} />;
  if (state.status === "written")
    return (
      <a className="routine-write" href={state.url} target="_blank" rel="noopener">
        {action.done}
      </a>
    );
  const run = async () => {
    setState({ status: "saving" });
    try {
      const { url } = draft
        ? await saveDraft(action.connectionId, draft, platformURL)
        : event
          ? await addEvent(action.connectionId, event, undefined, platformURL)
          : { url: "" };
      setState({ status: "written", url });
      onWritten?.(action.how);
    } catch (failure) {
      setState({
        status: "failed",
        reason: failure instanceof Error ? failure.message : "Could not save it",
      });
    }
  };
  return (
    <>
      <button type="button" className="routine-write" disabled={state.status === "saving"} aria-busy={state.status === "saving"} onClick={() => void run()}>
        {state.status === "saving" ? "Saving…" : action.label}
      </button>
      {state.status === "failed" ? <span role="alert">{state.reason}</span> : null}
    </>
  );
}

export function CopyButton({ text, label, onCopied }: { text: string; label: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopied?.();
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="routine-copy" aria-label={label} onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A time as the member reads it: a date alone, or the date and time in their own zone. */
function When({ value }: { value: string }) {
  const date = new Date(value);
  const text = Number.isNaN(date.getTime())
    ? value
    : value.length === 10
      ? date.toLocaleDateString(undefined, {
          dateStyle: "medium",
          timeZone: "UTC",
        })
      : date.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
  // The server renders in UTC and the browser in the member's zone.
  return (
    <time dateTime={value} suppressHydrationWarning>
      {text}
    </time>
  );
}

/** One item: its line, the draft or event it carries, Copy, and its write button. */
function ItemRow({
  item,
  writers,
  returnTo,
  onCopied,
  onWritten,
}: {
  item: ResultItem;
  writers?: ResultWriters;
  returnTo?: string;
  onCopied?: () => void;
  onWritten?: (how: RoutineFinish) => void;
}) {
  const { draft, event } = item;
  return (
    <li>
      <div>
        <strong>{item.title}</strong>
        {item.detail ? <span>: {item.detail}</span> : null}
      </div>
      {draft ? (
        <blockquote className="routine-item-draft">
          <p>
            <strong>To:</strong> {draft.to.length ? draft.to.join(", ") : "(fill in)"} · <strong>Subject:</strong> {draft.subject}
          </p>
          <Markdown>{draft.body}</Markdown>
        </blockquote>
      ) : null}
      {event ? (
        <p className="routine-item-event">
          {event.title} · <When value={event.start} /> to <When value={event.end} />
          {event.attendees?.length ? ` · with ${event.attendees.join(", ")}` : ""}
        </p>
      ) : null}
      <span className="routine-item-actions">
        <CopyButton text={itemText(item)} label={`Copy ${item.title}`} onCopied={onCopied} />
        {writers ? <WriteButton item={item} writers={writers} returnTo={returnTo} onWritten={onWritten} /> : null}
      </span>
    </li>
  );
}

/** Copy the whole result and, when the run can be finished here, "Mark completed". */
export function ResultActions({ text, run }: { text: string; run: ReturnType<typeof useRunFinish> }) {
  const { state, error, finish, copied } = run;
  return (
    <>
      <p className="routine-result-actions">
        <CopyButton text={text} label="Copy the whole result" onCopied={copied} />
        {copied ? (
          <button
            type="button"
            className="routine-complete"
            disabled={state !== "open"}
            aria-busy={state === "saving"}
            data-completed={state === "completed" || undefined}
            onClick={() => void finish("marked")}
          >
            {state === "completed" ? "✓ Completed" : state === "saving" ? "Saving…" : "Mark completed"}
          </button>
        ) : null}
      </p>
      {copied && state !== "completed" ? <p className="routine-result-note">Copy what you need or mark it completed when you are done.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

/**
 * A routine's result. `label` names the region for assistive technology;
 * `writers` are the member's Google connections its drafts and events save with.
 */
export default function RoutineResultView({
  result,
  label = "Result",
  completion,
  writers,
  returnTo,
}: {
  result: RecurringTaskResult;
  label?: string;
  completion?: RoutineCompletion;
  writers?: ResultWriters;
  /** This page's path, where Google consent returns when a button connects. */
  returnTo?: string;
}) {
  const run = useRunFinish(completion, usePlatformURL());
  const { copied } = run;
  return (
    <section className="routine-result-view" aria-label={label}>
      <p className="routine-result-headline">
        <strong>{result.headline}</strong>
      </p>
      {result.body.trim() ? (
        <div className="routine-result-body">
          <Markdown>{result.body}</Markdown>
        </div>
      ) : null}
      {result.items.length ? (
        <ul className="routine-result-items">
          {result.items.map((item) => (
            <ItemRow
              key={`${item.title}\u0000${item.detail}`}
              item={item}
              writers={writers}
              returnTo={returnTo}
              onCopied={copied}
              onWritten={(how) => void run.finish(how)}
            />
          ))}
        </ul>
      ) : null}
      {result.couldNotRead ? <p className="routine-result-note">{result.couldNotRead}</p> : null}
      <ResultActions text={routineResultText(result)} run={run} />
    </section>
  );
}
