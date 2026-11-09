import { partSchema, type ThreadEntry, type ThreadPart, type ThreadRef, type ThreadSchemaDescriptor } from "@ai-outfitter/app-sdk/threads";
import type { ReactNode } from "react";
import Markdown from "../Markdown";
import "./timeline.css";

/** The part shape a host may pass; unknown types use the structured fallback. */
export type TimelinePart = ThreadPart | { type: string; [key: string]: unknown };
export type TimelineEntry = Pick<ThreadEntry, "id" | "role" | "status" | "createdAt" | "recordedAt"> & {
  parts: readonly TimelinePart[];
  attribution?: Partial<ThreadEntry["attribution"]>;
};
type DataPart = Extract<ThreadPart, { type: "data" }>;
type ProposalPart = Extract<ThreadPart, { type: "proposal" }>;

export type TimelineRenderers = {
  /** App-owned renderers for `data` extension parts, by namespaced name. */
  data?: Record<string, (part: DataPart) => ReactNode>;
  /** App-owned proposal review; the default shows the link's recorded status. */
  proposal?: (part: ProposalPart) => ReactNode;
  /** Open an available artifact (e.g. resolve a short-lived read URL); the default is a plain link. */
  openArtifact?: (part: Extract<ThreadPart, { type: "artifact" }>) => void;
};
export type TimelineProps = {
  entries: readonly TimelineEntry[];
  /** Opens a linked child, session or parent timeline. Links render as text without it. */
  onOpenThread?: (ref: ThreadRef, title?: string) => void;
  renderers?: TimelineRenderers;
  /** Conversation timelines show when an entry was written; history timelines only show recorded source times. */
  timestamps?: "recorded" | "created";
  /** Extra controls per entry, e.g. "Start a child conversation". */
  entryActions?: (entry: TimelineEntry) => ReactNode;
  empty?: ReactNode;
  label?: string;
  /** Schemas the provider published in `threads.types`: label structured `data` parts by their title. */
  schemas?: readonly ThreadSchemaDescriptor[];
};

const roleLabel: Record<string, string> = { user: "Member", assistant: "Assistant", note: "Note", event: "Event" };

function time(value: number) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
}

/**
 * A generic, escaped view of JSON-like data: objects become description lists,
 * arrays ordered lists and scalars text. Nothing is interpreted as markup or a
 * link. Depth and breadth are bounded; the remainder is summarized.
 */
export function StructuredValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return <span className="timeline-null">none</span>;
  if (typeof value !== "object") return <span className="timeline-scalar">{String(value)}</span>;
  if (depth >= 4) return <code className="timeline-scalar">{JSON.stringify(value).slice(0, 400)}</code>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="timeline-null">empty list</span>;
    return (
      <ol className="timeline-list">
        {value.slice(0, 50).map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional data has no id.
          <li key={index}><StructuredValue value={item} depth={depth + 1} /></li>
        ))}
        {value.length > 50 ? <li className="timeline-null">{value.length - 50} more items</li> : null}
      </ol>
    );
  }
  const fields = Object.entries(value as Record<string, unknown>);
  if (!fields.length) return <span className="timeline-null">empty</span>;
  return (
    <dl className="timeline-fields">
      {fields.slice(0, 50).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd><StructuredValue value={item} depth={depth + 1} /></dd>
        </div>
      ))}
      {fields.length > 50 ? <div><dt>…</dt><dd>{fields.length - 50} more fields</dd></div> : null}
    </dl>
  );
}

function Details({ summary, children, open = false }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="timeline-details" open={open}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

const availabilityText = {
  available: "Available",
  missing: "Missing: the referenced artifact no longer exists or was never stored.",
  expired: "Expired: the retained artifact passed its retention period.",
  incomplete: "Incomplete: the artifact was not completely stored.",
} as const;

/** The generic fallback for parts this renderer does not know; never dropped. */
function Unsupported({ part, schemas }: { part: TimelinePart; schemas?: TimelineProps["schemas"] }) {
  const name = part.type === "data" && typeof part.name === "string" ? part.name : part.type;
  const version = part.type === "data" && typeof part.version === "number" ? ` v${part.version}` : "";
  const data = part.type === "data" ? (part as DataPart).data : part;
  const title = part.type === "data" ? partSchema(schemas, name, typeof part.version === "number" ? part.version : undefined)?.title : undefined;
  return (
    <div className="timeline-part timeline-unsupported" data-part={name}>
      <Details summary={<>{title ?? "Structured content"}: <code>{name}{version}</code></>}>
        <StructuredValue value={data} />
      </Details>
    </div>
  );
}

/** `markdown` renders text parts as Markdown (assistant replies); other text stays as typed. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one case per typed thread part, each with its own escaped view.
export function TimelinePartView({ part, onOpenThread, renderers, schemas, markdown = false }: { part: TimelinePart; markdown?: boolean } & Pick<TimelineProps, "onOpenThread" | "renderers" | "schemas">): ReactNode {
  const p = part as ThreadPart;
  switch (p.type) {
    case "text":
      if (typeof p.text !== "string") return <Unsupported part={part} />;
      return markdown
        ? <div className="timeline-part timeline-markdown"><Markdown>{p.text}</Markdown></div>
        : <p className="timeline-part timeline-text">{p.text}</p>;
    case "file":
      return <img className="timeline-part timeline-file" src={p.url} alt={p.filename || "Attachment"} />;
    case "tool-call":
      return (
        <div className="timeline-part timeline-tool">
          <Details summary={<>Used tool <code>{p.name}</code></>}><StructuredValue value={p.input} /></Details>
        </div>
      );
    case "tool-result":
      return (
        <div className="timeline-part timeline-tool" data-error={p.error ? "true" : undefined}>
          <Details summary={<>{p.error ? "Tool failed" : "Tool result"}: <code>{p.name}</code></>}>
            {p.error ? <p role="note">{p.error}</p> : null}
            <StructuredValue value={p.output} />
          </Details>
        </div>
      );
    case "proposal":
      return renderers?.proposal ? (
        <div className="timeline-part timeline-proposal">{renderers.proposal(p)}</div>
      ) : (
        <p className="timeline-part timeline-proposal">
          Proposal {p.label ?? p.proposalId}
          {p.action ? ` · ${p.action.replaceAll("_", " ")}` : ""}
          {p.status ? ` · ${p.status}` : ""}
          {p.revision ? ` · revision ${p.revision}` : ""}
        </p>
      );
    case "workflow-input":
      return (
        <div className="timeline-part timeline-workflow">
          <Details summary={<>Input <code>{p.name}</code></>}><StructuredValue value={p.value} /></Details>
        </div>
      );
    case "workflow-output":
      return (
        <div className="timeline-part timeline-workflow" data-complete={String(p.complete)}>
          <Details summary={<>Output <code>{p.name}</code> · {p.complete ? "complete" : "incomplete"}</>}>
            <StructuredValue value={p.value} />
          </Details>
        </div>
      );
    case "attempt":
      return (
        <div className="timeline-part timeline-attempt" data-state={p.state}>
          <p>
            Attempt on <code>{p.nodeId}</code> · <strong>{p.state}</strong>
            {p.createdAt ? <> · started {time(p.createdAt)}</> : null}
            {p.updatedAt ? <> · updated {time(p.updatedAt)}</> : null}
          </p>
          {p.failure ? <p className="timeline-failure">{p.failure}</p> : null}
        </div>
      );
    case "status":
      return (
        <p className="timeline-part timeline-status" data-status={p.status}>
          Status: <strong>{p.label ?? p.status}</strong>
          {p.detail ? ` · ${p.detail}` : ""}
        </p>
      );
    case "artifact":
      return (
        <div className="timeline-part timeline-artifact" data-availability={p.availability}>
          <p>
            {p.availability === "available" && p.url && renderers?.openArtifact ? (
              <button type="button" className="ui-button ui-button--secondary" onClick={() => renderers.openArtifact?.(p)}>Open {p.name}</button>
            ) : p.availability === "available" && p.url ? (
              <a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a>
            ) : (
              <strong>{p.name}</strong>
            )}
            {p.contentType ? ` · ${p.contentType}` : ""}
          </p>
          <p className="timeline-availability">{availabilityText[p.availability] ?? p.availability}</p>
        </div>
      );
    case "thread-link":
      return (
        <p className="timeline-part timeline-link" data-relation={p.relation}>
          {onOpenThread ? (
            <button type="button" className="ui-button ui-button--secondary" onClick={() => onOpenThread(p.ref, p.title)}>
              Open {p.relation} timeline{p.title ? `: ${p.title}` : ""}
            </button>
          ) : (
            <>Linked {p.relation} timeline{p.title ? `: ${p.title}` : ""}</>
          )}
        </p>
      );
    case "data": {
      const render = renderers?.data?.[p.name];
      return render ? <div className="timeline-part">{render(p)}</div> : <Unsupported part={part} schemas={schemas} />;
    }
    default:
      return <Unsupported part={part} />;
  }
}

/** A typed thread timeline: chat, tools, proposal links, workflow history and app extensions. */
export default function Timeline({ entries, onOpenThread, renderers, timestamps = "created", entryActions, empty, label = "Timeline", schemas }: TimelineProps) {
  if (!entries.length) return <div className="timeline-empty">{empty ?? "No entries yet."}</div>;
  return (
    <ol className="timeline" aria-label={label}>
      {entries.map((entry) => {
        const when = entry.recordedAt ?? (timestamps === "created" ? entry.createdAt : null);
        const actor = entry.attribution?.actor;
        return (
          <li key={entry.id} className="timeline-entry" data-role={entry.role} data-status={entry.status}>
            <div className="timeline-meta">
              <span className="timeline-role">{actor?.label ?? roleLabel[entry.role] ?? entry.role}</span>
              {when !== null && when !== undefined ? time(when) : <span className="timeline-null">no recorded time</span>}
              {entry.status !== "complete" ? <span className="timeline-badge">{entry.status}</span> : null}
            </div>
            <div className="timeline-body">
              {entry.parts.map((part, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: entry parts are immutable and ordered.
                <TimelinePartView key={index} part={part} onOpenThread={onOpenThread} renderers={renderers} schemas={schemas} markdown={entry.role === "assistant"} />
              ))}
            </div>
            {entryActions ? <div className="timeline-actions">{entryActions(entry)}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}
