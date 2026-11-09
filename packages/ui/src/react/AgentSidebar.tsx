import { setUiPreference, uiPreferences } from "@ai-outfitter/app-sdk/ui-preferences";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
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
   * supplies the authorized saved thread for the current owner and context.
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
  onOpenChange?: (open: boolean) => void;
  /** sessionStorage key that reopens the panel after a full-page navigation. */
  openStorageKey?: string;
  /** Rendered open, from the `outfitter-ui` cookie the server read; opening and closing keep that cookie current. */
  initialOpen?: boolean;
  /** One-shot: the panel opens on mount when this session key is set (then cleared), e.g. after the agent navigated. */
  reopenKey?: string;
  /** What goes inert while the panel covers a phone screen; defaults to the shared AppLayout's columns. */
  inertSelector?: string;
  /** Context controls above the composer, available throughout the conversation. */
  composerActions?: ReactNode;
  /** Platform administrators' session debug page (`/debug/session`); without `debug`, the header links Debug to it in a new tab. */
  debugHref?: string;
  /** Platform administrators' in-panel debug view; when given, Debug shows it in place of the transcript (it links `debugHref`). */
  debug?: ReactNode;
  /** Prepare a session when the in-panel debugger opens. */
  onDebugOpen?: () => void;
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
  const [open, setOpen] = useState(props.initialOpen ?? false);
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
    // The server renders the panel as the member left it (app-sdk ui-preferences).
    if (next) setUiPreference("agent", id);
    else if (uiPreferences(document.cookie).agent === id) setUiPreference("agent", undefined);
    if (next) focusOnOpen.current = takeFocus;
    else focusOnClose.current = takeFocus;
    latest.current.onOpenChange?.(next);
  }

  // Reopen after navigation, without taking focus from the new page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores once per page.
  useEffect(() => {
    // Rendered open by the server: the host loads the conversation as on any open.
    if (props.initialOpen) latest.current.onOpenChange?.(true);
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
  const [debugging, setDebugging] = useState(false);
  const showDebug = debugging && props.debug !== undefined;
  const header = (
    <header className="agent-sidebar-header">
      <div className="agent-sidebar-title">
        <h2>
          <Icon name={agent.icon ?? "spark"} size={16} /> {agent.name}
        </h2>
        {focus ? <FocusLine focus={focus} /> : null}
      </div>
      {props.debug !== undefined ? (
        <button type="button" className="agent-sidebar-action" onClick={() => { if (!showDebug) props.onDebugOpen?.(); setDebugging((on) => !on); }} aria-pressed={showDebug} title="Debug">
          <Icon name="code" size={18} />
          <span className="visually-hidden">Debug</span>
        </button>
      ) : props.debugHref ? (
        <a className="agent-sidebar-action" href={props.debugHref} data-astro-reload="" title="Debug">
          <Icon name="code" size={18} />
          <span className="visually-hidden">Debug</span>
        </a>
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
      <ResizeHandle panel={panel} label={label} />
      {conversation ? (
        <Conversation key={conversation.id} {...props} conversation={conversation} header={header} busy={busy} active={open} debugging={showDebug} />
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
  debug,
  debugging,
}: AgentSidebarProps<M> & { conversation: AgentConversation<M>; header: ReactNode; busy: boolean; active: boolean; debugging: boolean }) {
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
      {debugging ? debug : <>{!messages.length ? (
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
      {composerActions}</>}
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

const MIN_WIDTH = 280;
const STEP = 32;

/** The panel's width, applied as a CSS variable (CSSOM, so no inline style attribute reaches the page's policy). */
function applyWidth(panel: HTMLElement | null, width: number | undefined) {
  if (!panel) return;
  if (width === undefined) panel.style.removeProperty("--agent-sidebar-width");
  else panel.style.setProperty("--agent-sidebar-width", `${width}px`);
}
/** The page keeps at least this much beside the panel: one card's width and its gutters. */
const MIN_PAGE = 400;
/** The widest the panel may grow: what the page column and the panel share now, less MIN_PAGE. */
function maxWidth(panel: HTMLElement | null) {
  const page = panel?.closest(".app-shell")?.querySelector<HTMLElement>(":scope > .app-main");
  const shared = (page?.getBoundingClientRect().width ?? window.innerWidth * 0.6) + (panel?.getBoundingClientRect().width ?? 0);
  return Math.max(MIN_WIDTH, Math.round(Math.min(shared - MIN_PAGE, window.innerWidth * 0.7)));
}
const clampWidth = (panel: HTMLElement | null, width: number) => Math.round(Math.min(maxWidth(panel), Math.max(MIN_WIDTH, width)));

/**
 * Drag (or arrow keys) on the panel's inner edge to resize it; double-click resets.
 * The width is kept in the outfitter-ui cookie, shared by every agent sidebar.
 */
function ResizeHandle({ panel, label }: { panel: RefObject<HTMLElement | null>; label: string }) {
  const [dragging, setDragging] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applies the saved width once.
  useEffect(() => {
    try {
      const saved = uiPreferences(document.cookie).agentWidth;
      applyWidth(panel.current, saved === undefined ? undefined : clampWidth(panel.current, saved));
    } catch {}
  }, []);
  const save = (width: number | undefined) => {
    applyWidth(panel.current, width);
    setUiPreference("agentWidth", width);
  };
  const current = () => panel.current?.getBoundingClientRect().width ?? 416;
  return (
    <button
      type="button"
      className="agent-sidebar-resize"
      aria-label={`Resize ${label}`}
      title="Drag to resize · double-click to reset"
      data-dragging={dragging ? "" : undefined}
      onDoubleClick={() => save(undefined)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        save(clampWidth(panel.current, current() + (event.key === "ArrowLeft" ? STEP : -STEP)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = current();
        let width = startWidth;
        setDragging(true);
        // The panel sits at the inline end, so dragging left widens it.
        const move = (moved: PointerEvent) => {
          width = clampWidth(panel.current, startWidth + (startX - moved.clientX));
          applyWidth(panel.current, width);
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
          setDragging(false);
          save(width);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
    />
  );
}
