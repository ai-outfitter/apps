import { defaultEffort, imageAttachments } from "@ai-outfitter/app-sdk/chat-input";
import { SIDEBAR_THREAD, threadClient } from "@ai-outfitter/app-sdk/threads";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import AgentDebug from "../AgentDebug";
import AgentSidebar from "../AgentSidebar";
import { sessionDebugHref, useAgentInspector } from "../agent-debug";
import Markdown from "../Markdown";
import { ChatTaskQuestion, ChatToolPart } from "./ChatComponents";
import { ChatComponentContext } from "./context";
import { activeTaskQuestion } from "./message-helpers";
import { type SidebarActivity, shownEntry, uiMessage } from "./thread-messages";
import "../../styles/sidebar-chat-cards.css";

/** The panel's one thread for this member and owner, as the page named it on the server. */
type SidebarThread = { id: string; context: { type: string; id: string } };
type Selected = { id: string; messages: UIMessage[]; persisted: boolean };
// randomUUID is restricted to secure contexts; local development also runs over VPN HTTP.
function randomId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// The chat useChat holds until the saved conversation loads; it never sends.
const PENDING = "pending";
/** Entries the panel shows on open; the model's own view is bounded by compaction, not by this. */
const SHOWN_ENTRIES = 200;

/**
 * The panel's one thread for this member and owner. The platform names its id, so every device and
 * browser continues the same conversation; until the first message it is not stored yet.
 */
async function sidebarConversation(id: string): Promise<Selected> {
  const threads = threadClient();
  const thread = await threads.get(id).catch(() => null);
  if (!thread) return { id, messages: [], persisted: false };
  const { entries } = await threads.entries(id, { limit: SHOWN_ENTRIES });
  return { id, persisted: true, messages: entries.filter(shownEntry).map(uiMessage) };
}

/**
 * "Ask Outfitter" beside a platform page: the shared agent sidebar over the
 * member's one `platform.sidebar` thread for this owner. The platform provides
 * that thread type itself, so no app is installed
 * or asked for; turns go to the platform's thread routes. It has no focus:
 * Outfitter does not see the page it sits beside.
 */
export default function ThreadSidebarChat({ id, userId, scopeKey, thread, label = "Outfitter" }: {
  /** The panel's id, which its header toggle controls. */
  id: string;
  userId: string;
  /** The owner scope (an organization id, or "personal"): switching it switches conversations. */
  scopeKey: string;
  /** The member's sidebar thread for this owner (`sidebarThreadId`, `sidebarContext`). */
  thread: SidebarThread;
  label?: string;
}) {
  // Pages without the ClientRouter reload on navigation; this key carries whether
  // the panel is open to the next page. The thread itself is named by the platform.
  const chatKey = `outfitter:sidebar-chat:${userId}:${scopeKey}`;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [notice, setNotice] = useState("");
  const effort = useRef(defaultEffort);
  const current = useRef(selected);
  current.current = selected;
  const client = useMemo(() => threadClient(), []);
  const stored = useRef<Promise<unknown> | null>(null);

  // The first open loads the panel's one thread.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once, on first open.
  useEffect(() => {
    if (!open || selected) return;
    let active = true;
    sidebarConversation(thread.id).catch(() => {
      setNotice("Could not load your earlier messages. Close and reopen the panel to try again.");
      // Still the panel's own thread: sending continues it.
      return { id: thread.id, messages: [], persisted: false };
    }).then((restored) => {
      if (!active) return;
      if (restored.persisted) stored.current = Promise.resolve();
      setSelected(restored);
    });
    return () => {
      active = false;
    };
  }, [open]);

  /** Stores the conversation before its first turn or upload: the member's own, private. */
  function ready() {
    const chat = current.current;
    if (!chat) return Promise.reject(new Error("Chat is not ready yet."));
    // Creating the platform-named thread again is a replay: it answers the same thread.
    stored.current ??= client.create({ id: chat.id, type: SIDEBAR_THREAD, visibility: "private", context: thread.context }).then(() => {
      setSelected((value) => (value && value.id === chat.id ? { ...value, persisted: true } : value));
    }, (error) => {
      stored.current = null;
      throw error;
    });
    return stored.current;
  }
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const { messages, sendMessage, status, error, stop, regenerate } = useChat({
    id: selected?.id ?? PENDING,
    messages: selected?.messages ?? [],
    generateId: randomId,
    transport: new DefaultChatTransport({
      api: "/api/platform/threads",
      fetch: async (input, init) => {
        await readyRef.current();
        return fetch(input, init);
      },
      prepareSendMessagesRequest: ({ id: threadId, messages: sent, trigger }) => {
        const message = sent.filter((m) => m.role === "user").at(-1);
        const intent = (message?.metadata as { intent?: string } | undefined)?.intent;
        return {
          api: client.submissionsURL(threadId),
          body: {
            submissionId: message?.id,
            text: (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            attachments: (message?.parts ?? []).flatMap((part) => (part.type === "file" ? [part.url.slice(part.url.lastIndexOf("/") + 1).split("?")[0]] : [])),
            effort: effort.current,
            ...(intent ? { metadata: { intent } } : {}),
            ...(trigger === "regenerate-message" ? { retry: true } : {}),
          },
        };
      },
    }),
  });
  const busy = status === "streaming" || status === "submitted";
  const inspector = useAgentInspector(client, open);
  const persistedId = selected?.persisted ? selected.id : null;
  const taskQuestion = activeTaskQuestion(messages);

  return (
    <ChatComponentContext.Provider value={{ signedIn: true, chatPath: "/", busy, send: (text, intent) => { void sendMessage({ text, ...(intent ? { metadata: { intent } } : {}) }); } }}>
    <AgentSidebar
      id={id}
      agent={{ name: label }}
      focus={null}
      scope={{
        intro: "Ask Outfitter anything while you work. This thread is saved and private to you.",
        limits: "Outfitter can't see or change this page.",
      }}
      conversation={selected ? { id: selected.id, messages, status, error: error ? error.message || "Could not send your message." : undefined, notice } : null}
      openStorageKey={`${chatKey}:open`}
      onOpenChange={setOpen}
      input={{ attachments: imageAttachments, effortEnabled: true, onEffortChange: (next) => { effort.current = next; } }}
      composerActions={taskQuestion ? <ChatTaskQuestion part={taskQuestion} /> : undefined}
      onSend={async ({ text, files }) => {
        if (busy || !selected) return false;
        let parts: FileUIPart[] = [];
        if (files.length) {
          await readyRef.current();
          parts = await Promise.all(files.map(async (file) => {
            const uploaded = await client.upload(selected.id, file);
            return { type: "file" as const, mediaType: uploaded.mediaType, filename: uploaded.filename, url: uploaded.url };
          }));
        }
        void sendMessage(parts.length ? { text, files: parts } : { text });
      }}
      onStop={() => void stop()}
      onRetry={() => void regenerate()}
      debugHref={inspector && persistedId ? sessionDebugHref(persistedId) : undefined}
      debug={inspector ? <SidebarDebug threads={client} threadId={persistedId} revision={messages.findLast((message) => message.role === "user")?.id} /> : undefined}
      onDebugOpen={() => { void ready().catch(() => setNotice("Could not prepare this chat for debugging.")); }}
      renderContent={(message, context) => <SidebarMessage message={message} busy={context.busy} answered={context.messages.slice(context.index + 1).some((item) => item.role === "user")} />}
    />
    </ChatComponentContext.Provider>
  );
}

/** Render normal Chat cards in the sidebar, keeping graph activity compact. */
function SidebarMessage({ message, busy, answered }: { message: UIMessage; busy: boolean; answered: boolean }) {
  const { activity, at } = (message.metadata ?? {}) as { activity?: SidebarActivity; at?: number };
  if (activity) return <ActivityCard activity={activity} at={at} />;
  const graph = message.parts.filter((part) => part.type === "tool-graph_query" || part.type === "tool-graph_documents");
  const graphFailed = graph.some((part) => "state" in part && part.state === "output-error");
  const stopped = message.role === "assistant" && ["aborted", "error"].includes((message.metadata as { status?: string } | undefined)?.status ?? "");
  return <>
    {graph.length ? <p role="status">{busy ? "Checking your connected information…" : graphFailed ? "Some connected information could not be checked." : "Checked your connected information."}</p> : null}
    {message.parts.map((part, index) => {
      if (part.type === "text") {
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are ordered and text has no id.
        return <Markdown key={index}>{part.text}</Markdown>;
      }
      if (part.type === "file") {
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are ordered and files have no id.
        return <img key={index} className="message-attachment" src={part.url} alt={part.filename || ""} />;
      }
      if (part.type.startsWith("tool-") && !graph.includes(part) && "toolCallId" in part)
        return <ChatToolPart key={part.toolCallId} part={part} answered={answered} />;
      return null;
    })}
    {stopped ? <p role="status">This reply did not finish. Send another message to continue.</p> : null}
  </>;
}

const ACTIVITY_LABEL = { complete: "Run finished", failed: "Run failed", created: "Routine turned on" } as const;
const ACTIVITY_LINK = { run: "Open run", routine: "Open routine" } as const;

/** Something that happened for the member, recorded by the platform: what, when, its result and where to look. */
function ActivityCard({ activity, at }: { activity: SidebarActivity; at?: number }) {
  const when = at ? new Date(at) : null;
  return (
    <section className={`sidebar-activity sidebar-activity--${activity.status}`} aria-label={`${ACTIVITY_LABEL[activity.status]}: ${activity.title}`}>
      <p className="sidebar-activity__label">
        {ACTIVITY_LABEL[activity.status]}
        {when ? <time dateTime={when.toISOString()}>{when.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</time> : null}
      </p>
      <p className="sidebar-activity__title">{activity.title}</p>
      {activity.summary ? <p className="sidebar-activity__summary">{activity.summary}</p> : null}
      <a className="sidebar-activity__link" href={activity.href}>{ACTIVITY_LINK[activity.kind]}</a>
    </section>
  );
}

/** The in-panel debug view for a saved conversation, linking the full session debug page. */
function SidebarDebug({ threads, threadId, revision }: { threads: Parameters<typeof AgentDebug>[0]["threads"]; threadId: string | null; revision?: string }) {
  return <AgentDebug threads={threads} threadId={threadId} href={threadId ? sessionDebugHref(threadId) : undefined} revision={revision} />;
}
