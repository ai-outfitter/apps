import type { ThreadInspection, ThreadPart, threadClient } from "@ai-outfitter/app-sdk/threads";
import { type ReactNode, useEffect, useState } from "react";
import { type TimelineEntry, TimelinePartView } from "./timeline/Timeline";
import CodeBlock, { JsonBlock } from "./CodeBlock";
import { tokenLabel } from "../token-estimate";
import "../styles/agent-debug.css";

type Threads = Pick<ReturnType<typeof threadClient>, "inspect">;

/**
 * Platform administrators' quick view of a conversation's latest turn, inside the
 * sidebar: the model and provider, the system prompt, the tools and the context the
 * app adds (such as the page the member is on), as the platform prepares it again now.
 * `threads` is the page's own thread client: a mounted app may only reach its own
 * paths (its content security policy), so the view never calls the root debug API.
 * `href` links the full session debug page (transcript with tool calls, a composer) in
 * this tab, as a full page load: mounted apps are sandboxed without popups, and their
 * client router may not leave the app.
 * `metadata` is what a send from this page would carry; `revision` reloads the view
 * after each reply or page change.
 */
export default function AgentDebug({ threads, threadId, href, revision, metadata, entries = [] }: {
  threads: Threads;
  /** The conversation's entries, shown below the sections with their tool calls and results. */
  entries?: readonly TimelineEntry[];
  threadId: string | null;
  href?: string;
  revision?: string;
  metadata?: () => Record<string, unknown> | undefined;
}) {
  const [state, setState] = useState<{ data?: ThreadInspection; error?: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision reloads after a reply.
  useEffect(() => {
    if (!threadId) return setState(null);
    let active = true;
    setState(null);
    let sent: Record<string, unknown> | undefined;
    try {
      sent = metadata?.();
    } catch {}
    threads.inspect(threadId, sent ? { metadata: sent as never } : {}).then(
      (data) => active && setState({ data }),
      (error: unknown) => active && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      active = false;
    };
  }, [threads, threadId, revision]);

  const full = href ? <p className="agent-debug-link"><a href={href} data-astro-reload="">Open full session debug →</a></p> : null;
  if (!threadId) return <section className="agent-debug" aria-label="Debug"><p className="agent-debug-note">Send a message to see what the model receives.</p></section>;
  if (!state) return <section className="agent-debug" aria-label="Debug">{full}<p className="agent-debug-note" role="status">Loading…</p></section>;
  if (state.error || !state.data) return <section className="agent-debug" aria-label="Debug">{full}<p role="alert">{state.error}</p></section>;
  const { model, turn } = state.data;
  return (
    <section className="agent-debug" aria-label="Debug">
      {full}
      <h3>Model</h3>
      {"error" in model ? <p role="alert">{model.error}</p> : <p>{model.model} <span className="agent-debug-muted">· {model.provider}</span></p>}
      {turn ? <Turn turn={turn} /> : <p className="agent-debug-muted">Send a message to see the system prompt, tools and context.</p>}
      <Transcript entries={entries} />
    </section>
  );
}

const shown = (value: unknown) => value !== null && value !== undefined && !(typeof value === "object" && !Object.keys(value).length);

/** A collapsed section whose summary carries an approximate token count. */
function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <details className="agent-debug-section">
      <summary><h3>{title}</h3> <span className="agent-debug-muted">{tokenLabel(text)}</span></summary>
      {children}
    </details>
  );
}

function Turn({ turn }: { turn: NonNullable<ThreadInspection["turn"]> }) {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return (
    <>
      {shown(turn.metadata) ? <Section title="Current page" text={json(turn.metadata)}><JsonBlock value={turn.metadata} /></Section>
        : <p className="agent-debug-muted">Current page: none sent.</p>}
      {turn.system ? <Section title="System prompt" text={turn.system}><CodeBlock code={turn.system} language="markdown" /></Section>
        : <p className="agent-debug-muted">System prompt: empty.</p>}
      {turn.tools.length ? (
        <Section title={`Tools (${turn.tools.length})`} text={json(turn.tools)}>
          <ul className="agent-debug-tools">
            {turn.tools.map((tool) => (
              <li key={tool.name}>
                <details>
                  <summary><code>{tool.name}</code></summary>
                  <p>{tool.description}</p>
                  <JsonBlock value={tool.inputSchema} />
                </details>
              </li>
            ))}
          </ul>
        </Section>
      ) : <p className="agent-debug-muted">Tools: none.</p>}
      {shown(turn.context) ? <Section title="Context" text={json(turn.context)}><JsonBlock value={turn.context} /></Section>
        : <p className="agent-debug-muted">Context: none.</p>}
      <p className="agent-debug-muted">History {JSON.stringify(turn.history)} · up to {turn.maxSteps} steps · {turn.maxOutputTokens} output tokens</p>
    </>
  );
}

/** The conversation as stored: each message with its tool calls and results between them. */
function Transcript({ entries }: { entries: readonly TimelineEntry[] }) {
  if (!entries.length) return null;
  return (
    <>
      <h3>Conversation</h3>
      <ol className="agent-debug-transcript">
        {entries.map((entry) => (
          <li key={entry.id} data-role={entry.role}>
            <p className="agent-debug-muted">{entry.role}{entry.status !== "complete" ? ` · ${entry.status}` : ""}</p>
            {entry.parts.map((part, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entry parts are immutable and ordered.
              <TranscriptPart key={index} part={part} />
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}

function TranscriptPart({ part }: { part: TimelineEntry["parts"][number] }) {
  const p = part as ThreadPart;
  if (p.type === "tool-call")
    return <details className="agent-debug-tool"><summary><code>→ {p.name}</code></summary><JsonBlock value={p.input} /></details>;
  if (p.type === "tool-result")
    return (
      <details className="agent-debug-tool" data-error={p.error ? "true" : undefined}>
        <summary><code>← {p.name}{p.error ? " · error" : ""}</code></summary>
        {p.error ? <p role="note">{p.error}</p> : null}
        <JsonBlock value={p.output} />
      </details>
    );
  return <TimelinePartView part={part} markdown />;
}
