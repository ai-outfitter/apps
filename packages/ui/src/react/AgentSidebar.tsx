import { useEffect, useRef, useState, type ReactNode } from "react";
import ChatInput, { type ChatInputDraft, type ChatInputProps } from "./ChatInput";
import { defaultEffort } from "@ai-outfitter/app-sdk/chat-input";
import ChatPanel from "./ChatPanel";
import Icon from "./Icon";
import type { IconName } from "../icons";
import { type AgentFocus, describeFocus, sameFocus } from "../agent-focus";
import "../styles/agent-sidebar.css";

// Phones get the panel full-screen (see styles/agent-sidebar.css), so the page behind goes inert.
const NARROW = "(max-width: 760px)";

/** The least a message needs; AI SDK `UIMessage`s fit as they are. */
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: readonly { type: string }[];
}

export interface AgentConversation<M extends AgentMessage = AgentMessage> {
  /**
   * Changing it starts a fresh transcript and empties the composer. The host
   * decides when: per saved chat, per focus, or on New chat.
   */
  id: string;
  messages: readonly M[];
  status: "ready" | "submitted" | "streaming" | "error";
  /** A failed turn, shown with Retry when `onRetry` is set. */
  error?: string;
  /** A note above the transcript, such as a conversation that could not be restored. */
  notice?: string;
}

export interface AgentSendDraft extends ChatInputDraft {
  /** What the page showed when this was sent; the server re-reads and authorizes it. */
  focus: AgentFocus | null;
}

export interface AgentRenderContext<M extends AgentMessage> {
  index: number;
  messages: readonly M[];
  /** What the page shows now. Compare an action's target with `sameFocus` before offering it. */
  focus: AgentFocus | null;
  busy: boolean;
  /** Sends the member's next message, about the current focus. */
  send: (text: string) => void;
}

export interface AgentSidebarProps<M extends AgentMessage = AgentMessage> {
  /** The panel's element id; `[data-agent-sidebar-toggle][aria-controls=<id>]` buttons toggle it. */
  id: string;
  agent: { name: string; icon?: IconName };
  /** The page's selection, or null when the agent works without one. */
  focus: AgentFocus | null;
  /** Empty-state copy (inline content): what to ask, and what the agent can and cannot see or change. */
  scope: { intro: ReactNode; limits: ReactNode };
  /** Null while the host loads it. */
  conversation: AgentConversation<M> | null;
  /** Return or resolve false to keep the draft. */
  onSend: (draft: AgentSendDraft) => undefined | false | Promise<undefined | false>;
  onStop?: () => void;
  onRetry?: () => void;
  /** Shows New chat; the host resets or rescopes `conversation`. */
  onNewConversation?: () => void;
  onOpenChange?: (open: boolean) => void;
  /** sessionStorage key that reopens the panel after a full-page navigation. */
  openStorageKey?: string;
  /** One-shot: the panel opens on mount when this session key is set (then cleared), e.g. after the agent navigated. */
  reopenKey?: string;
  /** What goes inert while the panel covers a phone screen; defaults to the shared AppLayout's columns. */
  inertSelector?: string;
  /** Host header actions before New chat and Close, such as Open in full chat. */
  actions?: ReactNode;
  /** Context controls above the composer, available throughout the conversation. */
  composerActions?: ReactNode;
  /** Review cards whose local drafts must survive streamed-message replacement. */
  transcriptContent?: ReactNode;
  /** Enable only capabilities supported by the host transport. */
  input?: Pick<ChatInputProps, "attachments" | "effortEnabled" | "dictationEnabled" | "maxLength" | "onEffortChange">;
  /** A message's body. The default, `AgentMessageText`, shows text parts as plain text. */
  renderContent?: (message: M, context: AgentRenderContext<M>) => ReactNode;
  messageClassName?: (message: M) => string | undefined;
}

/**
 * An agent beside a page: a panel that page buttons marked
 * `data-agent-sidebar-toggle` open and close, with the agent's identity, the
 * page's focus, a transcript and a composer. It holds no transport, storage
 * or authority; the host supplies the conversation and acts on sends.
 */
export default function AgentSidebar<M extends AgentMessage = AgentMessage>(props: AgentSidebarProps<M>) {
  const { id, agent, focus, conversation, openStorageKey, reopenKey, inertSelector = ".app-shell > .sidebar, .app-shell > .app-main" } = props;
  const label = `${agent.name} chat`;
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(false);
  const focusOnClose = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const toggles = () =>
    document.querySelectorAll<HTMLButtonElement>(`[data-agent-sidebar-toggle][aria-controls="${CSS.escape(id)}"]`);

  function show(next: boolean, takeFocus = true) {
    setOpen(next);
    if (openStorageKey) {
      try {
        sessionStorage.setItem(openStorageKey, next ? "1" : "");
      } catch {}
    }
    if (next) focusOnOpen.current = takeFocus;
    else focusOnClose.current = takeFocus;
    latest.current.onOpenChange?.(next);
  }

  // Reopen after navigation, without taking focus from the new page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores once per page.
  useEffect(() => {
    try {
      const reopen = reopenKey ? sessionStorage.getItem(reopenKey) : null;
      if (reopenKey) sessionStorage.removeItem(reopenKey);
      if (reopen || (openStorageKey && sessionStorage.getItem(openStorageKey))) show(true, false);
    } catch {}
  }, []);

  // Toggles are the host's markup; they stay disabled until this runs.
  const showRef = useRef(show);
  showRef.current = show;
  const openRef = useRef(open);
  openRef.current = open;
  // biome-ignore lint/correctness/useExhaustiveDependencies: toggles are found by the fixed id.
  useEffect(() => {
    const click = () => showRef.current(!openRef.current);
    for (const button of toggles()) {
      button.disabled = false;
      button.addEventListener("click", click);
    }
    return () => {
      for (const button of toggles()) button.removeEventListener("click", click);
    };
  }, [id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: toggles are found by the fixed id.
  useEffect(() => {
    for (const button of toggles()) button.setAttribute("aria-expanded", String(open));
  }, [open, id]);

  // Focus the message box on open and on a new conversation; while the
  // conversation loads, hold focus on Close, inside the panel.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    if (!conversation?.id) {
      close.current?.focus();
      return;
    }
    focusOnOpen.current = false;
    if (window.matchMedia(NARROW).matches) close.current?.focus();
    else panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [open, conversation?.id]);
  useEffect(() => {
    if (!open) return;
    const narrow = window.matchMedia(NARROW);
    const background = () => document.querySelectorAll<HTMLElement>(inertSelector);
    const apply = () => {
      for (const element of background()) element.inert = narrow.matches;
    };
    apply();
    narrow.addEventListener("change", apply);
    return () => {
      narrow.removeEventListener("change", apply);
      for (const element of background()) element.inert = false;
    };
  }, [open, inertSelector]);
  // Closing returns focus to the toggle, once the page is no longer inert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: toggles are found by the fixed id.
  useEffect(() => {
    if (open || !focusOnClose.current) return;
    focusOnClose.current = false;
    toggles()[0]?.focus();
  }, [open]);

  const busy = conversation?.status === "submitted" || conversation?.status === "streaming";
  const { onNewConversation } = props;
  const header = (
    <header className="agent-sidebar-header">
      <div className="agent-sidebar-title">
        <h2>
          <Icon name={agent.icon ?? "spark"} size={16} /> {agent.name}
        </h2>
        {focus ? <FocusLine focus={focus} /> : null}
      </div>
      {props.actions}
      {onNewConversation ? (
        <button
          type="button"
          className="agent-sidebar-action"
          onClick={() => {
            focusOnOpen.current = true;
            onNewConversation();
          }}
          disabled={busy || !conversation}
          title="New chat"
        >
          <Icon name="compose" size={18} />
          <span className="visually-hidden">New chat</span>
        </button>
      ) : null}
      <button ref={close} type="button" className="agent-sidebar-action" onClick={() => show(false)} title={`Close ${label}`}>
        <Icon name="sidebar" size={18} />
        <span className="visually-hidden">Close {label}</span>
      </button>
    </header>
  );

  return (
    <aside
      ref={panel}
      id={id}
      className="agent-sidebar"
      aria-label={label}
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          show(false);
        }
      }}
    >
      {conversation ? (
        <Conversation key={conversation.id} {...props} conversation={conversation} header={header} busy={busy} active={open} />
      ) : (
        // Header and Close stay available, since a phone's page behind is inert.
        <div className="agent-sidebar-pending">
          {header}
          <p className="agent-sidebar-loading" role="status">
            Loading…
          </p>
        </div>
      )}
    </aside>
  );
}

function FocusLine({ focus }: { focus: AgentFocus }) {
  return (
    <p className="agent-sidebar-focus" data-focus-kind={focus.kind}>
      <span className="visually-hidden">Focus: </span>
      <strong>{focus.label}</strong>
      {focus.project ? <span>{focus.project.label}</span> : null}
      {focus.revision !== undefined ? <span>Revision {focus.revision}</span> : null}
    </p>
  );
}

/** The default message body: its text parts, as plain text. */
export function AgentMessageText({ message }: { message: AgentMessage }) {
  return (
    <>
      {message.parts.map((part, i) =>
        part.type === "text" && "text" in part && typeof part.text === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: message parts have no id and never reorder.
          <p key={i} className="agent-sidebar-text">
            {part.text}
          </p>
        ) : part.type === "file" && "url" in part && typeof part.url === "string" ? (
          <img key={part.url} className="agent-sidebar-attachment" src={part.url} alt={"filename" in part && typeof part.filename === "string" ? part.filename : "Attachment"} />
        ) : null,
      )}
    </>
  );
}

/** One conversation; remounted when its id changes, which empties the draft. */
function Conversation<M extends AgentMessage>({
  agent,
  focus,
  scope,
  conversation,
  header,
  busy,
  onSend,
  onStop,
  onRetry,
  renderContent,
  messageClassName,
  composerActions,
  transcriptContent,
  active,
  input,
}: AgentSidebarProps<M> & { conversation: AgentConversation<M>; header: ReactNode; busy: boolean; active: boolean }) {
  const { messages, status, error, notice } = conversation;
  const [draft, setDraft] = useState("");
  const [hasFiles, setHasFiles] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  // The focus the draft was started for, and the one the last message was sent about.
  const [draftFocus, setDraftFocus] = useState(focus);
  const [sentFocus, setSentFocus] = useState<AgentFocus | null | undefined>(undefined);
  // A draft never follows the page to another item, or revision, unasked.
  const stale = (draft.trim() !== "" || hasFiles) && !sameFocus(draftFocus, focus);
  const moved = sentFocus !== undefined && messages.length > 0 && !sameFocus(sentFocus, focus);

  function send(text: string, files: File[] = [], effort = defaultEffort) {
    const about = focus;
    const result = onSend({ text, files, effort, focus: about });
    if (result instanceof Promise) return result.then((r) => (r === false ? false : void setSentFocus(about)));
    if (result !== false) setSentFocus(about);
    return result;
  }
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const log = end.current?.closest(".ui-chat-transcript");
    if (!log) return;
    const track = () => { following.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80; };
    log.addEventListener("scroll", track, { passive: true });
    return () => log.removeEventListener("scroll", track);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow each new message and streamed part.
  useEffect(() => {
    const log = end.current?.closest(".ui-chat-transcript");
    if (log && following.current) log.scrollTop = log.scrollHeight;
  }, [messages, status]);

  const context = (index: number): AgentRenderContext<M> => ({ index, messages, focus, busy, send: (text) => void send(text) });
  return (
    <ChatPanel
      variant="sidebar"
      label={agent.name}
      header={header}
      composer={
        <>
          {error ? (
            <div className="agent-sidebar-alert" role="alert">
              {error}{" "}
              {onRetry ? (
                <button type="button" onClick={onRetry} disabled={busy}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {stale ? (
            <div className="agent-sidebar-stale" role="status">
              <p>
                Now viewing {describeFocus(focus)}. This draft was written for {describeFocus(draftFocus)}.
              </p>
              <button type="button" onClick={() => setDraftFocus(focus)}>
                Keep draft for {focus ? focus.label : "no selection"}
              </button>
              <button type="button" onClick={() => { setDraft(""); setHasFiles(false); setDraftVersion(v => v + 1); }}>
                Discard draft
              </button>
            </div>
          ) : null}
      <ChatInput
            {...input}
            active={active}
            key={draftVersion}
            value={draft}
            onChange={(value) => {
              if (!draft.trim() && !hasFiles && value.trim()) setDraftFocus(focus);
              setDraft(value);
            }}
            onFilesChange={(files) => {
              if (!hasFiles && files.length && !draft.trim()) setDraftFocus(focus);
              setHasFiles(files.length > 0);
            }}
            onSend={({ text, files, effort }) => {
              if ((!text.trim() && !files.length) || busy || stale) return false;
              return send(text.trim(), files, effort);
            }}
            onStop={onStop}
            sending={busy}
            label={`Message ${agent.name}`}
            placeholder={`Ask ${agent.name}…`}
            sendLabel={`Send to ${agent.name}`}
            sendIcon={<Icon name="send" />}
            stopIcon={<Icon name="stop" />}
          />
        </>
      }
    >
      {notice ? (
        <p className="agent-sidebar-alert" role="alert">
          {notice}
        </p>
      ) : null}
      {!messages.length ? (
        <div className="agent-sidebar-intro">
          <p>{scope.intro}</p>
          <p className="agent-sidebar-scope">{scope.limits}</p>
        </div>
      ) : (
        messages.map((message, index) => (
          <article
            key={message.id}
            className={["message", message.role, messageClassName?.(message)].filter(Boolean).join(" ")}
          >
            <div className="message-label">
              {message.role === "user" ? (
                "You"
              ) : (
                <>
                  <Icon name={agent.icon ?? "spark"} size={14} /> {agent.name}
                </>
              )}
            </div>
            <div className="message-body">
              {renderContent ? renderContent(message, context(index)) : <AgentMessageText message={message} />}
            </div>
          </article>
        ))
      )}
      {transcriptContent}
      {composerActions}
      {moved ? (
        <p className="agent-sidebar-moved" role="status">
          Earlier messages were about {describeFocus(sentFocus)}. New ones will be about {describeFocus(focus)}.
        </p>
      ) : null}
      {status === "submitted" ? <p className="thinking">Thinking…</p> : null}
      <div ref={end} />
    </ChatPanel>
  );
}
