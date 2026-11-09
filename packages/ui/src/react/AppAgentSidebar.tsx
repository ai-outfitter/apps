import { type AgentFocus, agentPage, type FieldOptions, type PageClaim } from "@ai-outfitter/app-sdk/agent-context";
import { agentPageKey, navigatePart, navigatePartName } from "@ai-outfitter/app-sdk/agent-page";
import { appEndpoint, appLocation, mountPrefix, openPage, pageHref, requestedPage } from "../agent-navigation";
import { changeDiff, type FieldSchema } from "@ai-outfitter/app-sdk/agent-schema";
import { imageAttachments } from "@ai-outfitter/app-sdk/chat-input";
import {
  type Thread,
  type ThreadEntry,
  type ThreadPart,
  type ThreadRef,
  type ThreadVisibility,
  submissionMetadataBytes,
  threadClient,
  threadRefKey,
} from "@ai-outfitter/app-sdk/threads";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { randomId } from "../random-id";
import AgentDebug from "./AgentDebug";
import { sessionDebugHref, useAgentInspector } from "./agent-debug";
import AgentSidebar, { type AgentMessage } from "./AgentSidebar";
import type { ChatInputDraft } from "./ChatInput";
import SchemaFields from "./SchemaFields";
import Timeline, { TimelinePartView, type TimelineEntry } from "./timeline/Timeline";
import "../styles/app-agent.css";
import "./timeline/timeline.css";

/** The app's proposal view, as its own endpoint returns it. Display data only. */
export type AppProposal = {
  id: string;
  threadId: string;
  action: string;
  targetId: string;
  targetLabel?: string;
  targetRevision: number;
  revision: number;
  status: string;
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
  schema: FieldSchema;
  fieldOptions?: FieldOptions;
  receipt?: unknown;
  timelineSynced?: boolean;
  recovery?: "same-request" | "inspect";
};
type ContextInfo = { cacheKey?: string; unresolved?: AppProposal[]; privateOnly?: boolean; type: string; context: { type: string; id: string; label?: string }; actions: unknown[] };
type HistoryGroup = { installationId: string; type: string; label: string; threads: Thread[]; error?: string };
type View =
  | { kind: "conversation"; thread: Thread | null }
  | { kind: "history"; ref: ThreadRef; title?: string };

const empty: PageClaim = { focus: null };
/** Planning-style apps carry the page claim as bounded entry metadata; the server re-authorizes it. */
const claimKey = (pageId: string) => `${pageId}.page`;
const metadataBudget = submissionMetadataBytes;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error((await response.text()).slice(0, 1000) || `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
function appClient(endpoint: string) {
  const call = <T,>(path: string, init: RequestInit = {}) =>
    fetch(endpoint + path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } }).then((r) => json<T>(r));
  return {
    context: (focus: string) => call<ContextInfo>(`/context?focus=${encodeURIComponent(focus)}`),
    proposals: (thread: string) => call<{ proposals: AppProposal[] }>(`/proposals?thread=${encodeURIComponent(thread)}`),
    revise: (id: string, revision: number, changes: unknown) => call<AppProposal>(`/proposals/${id}`, { method: "PUT", body: JSON.stringify({ revision, changes }) }),
    decide: (id: string, revision: number, decision: "approve" | "reject") =>
      call<{ proposal: AppProposal; receipt: unknown }>(`/proposals/${id}/${decision}`, { method: "POST", body: JSON.stringify({ revision }) }),
    histories: () => call<{ providers: HistoryGroup[] }>("/history"),
    history: (ref: ThreadRef, before?: string) =>
      call<{ thread: Thread; entries: ThreadEntry[]; before: string | null }>(`/history/entries?ref=${encodeURIComponent(threadRefKey(ref))}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  };
}

/**
 * Read an AI SDK UI message stream: text deltas for the live reply, errors as
 * messages. Persisted entries are reloaded from the thread afterwards.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over the reply stream's event kinds.
async function readStream(response: Response, onText: (text: string) => void) {
  if (!response.body) return;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", failure = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as { type?: string; delta?: string; errorText?: string };
          if (event.type === "text-delta" && typeof event.delta === "string") onText(event.delta);
          if (event.type === "error") failure = event.errorText ?? "The reply failed.";
        } catch {}
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (failure) throw new Error(failure);
}

function RecoveryActions({ proposal, busy, act }: {
  proposal: AppProposal;
  busy: boolean;
  act: (action: "approve" | "reject") => Promise<void>;
}) {
  const dismissed = proposal.receipt && typeof proposal.receipt === "object" &&
    "dismissed" in proposal.receipt && proposal.receipt.dismissed;
  if (proposal.status !== "uncertain" || !proposal.recovery || dismissed) return null;
  return (
    // Keep the composer focused during pointer activation; mobile input collapse would move these controls before click.
    <div className="agent-proposal-actions" onPointerDown={(event) => event.preventDefault()}>
      {proposal.recovery === "same-request" ? (
        <button type="button" className="ui-button" disabled={busy} onClick={() => void act("approve")}>Recover result</button>
      ) : null}
      <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void act("reject")}>Dismiss unresolved reminder</button>
    </div>
  );
}
function ProposalCard({ proposal, client, changed, options }: {
  proposal: AppProposal;
  client: ReturnType<typeof appClient>;
  changed: (applied: boolean) => Promise<void>;
  options?: FieldOptions;
}) {
  const [values, setValues] = useState(proposal.changes), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const edited = JSON.stringify(values) !== JSON.stringify(proposal.changes);
  async function act(action: "save" | "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      if (action === "save") await client.revise(proposal.id, proposal.revision, values);
      else await client.decide(proposal.id, proposal.revision, action);
      await changed(action === "approve");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save; your edits are preserved.");
      await changed(false).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const outcome: Record<string, string> = {
    applied: "Approved changes saved.",
    rejected: "Proposal rejected.",
    cancelled: "Proposal cancelled; nothing was saved.",
    uncertain: "Outcome unconfirmed; inspect the record before acting again.",
  };
  return (
    <section className="agent-proposal" aria-label="Review proposed change">
      <h3>{proposal.action.replaceAll("_", " ")}</h3>
      <p>Target {proposal.targetLabel ?? proposal.targetId} · revision {proposal.targetRevision} · {proposal.status}</p>
      {proposal.status === "pending" ? (
        <>
          <SchemaFields schema={proposal.schema} options={options} value={values} onChange={setValues} disabled={busy} />
          <details>
            <summary>Review changes</summary>
            {changeDiff(proposal.before, values).map((diff) => (
              <div key={diff.field}>
                <strong>{diff.field}</strong>
                <p>Before: {JSON.stringify(diff.before)}</p>
                <p>After: {JSON.stringify(diff.after)}</p>
              </div>
            ))}
          </details>
          <div className="agent-proposal-actions">
            <button type="button" className="ui-button ui-button--secondary" disabled={busy || !edited} onClick={() => void act("save")}>Save proposal edits</button>
            <button type="button" className="ui-button" disabled={busy || edited} onClick={() => void act("approve")}>Approve changes</button>
            <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => void act("reject")}>Reject</button>
          </div>
          {edited && <p>Save your proposal edits before approving.</p>}
        </>
      ) : (
        <p>{outcome[proposal.status] ?? proposal.status}{proposal.timelineSynced === false && proposal.status !== "cancelled" ? " The conversation record of this decision will be added on the next load." : ""}</p>
      )}
      <RecoveryActions proposal={proposal} busy={busy} act={act} />
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

type Message = AgentMessage & { entry: TimelineEntry };
const asMessage = (entry: TimelineEntry): Message => ({
  id: entry.id,
  role: entry.role === "user" ? "user" : "assistant",
  parts: entry.parts as readonly { type: string }[],
  entry,
});

/**
 * Standard app adapter on the shared thread service. The platform stores the
 * conversation and runs replies; the app endpoint serves page context,
 * proposals, decisions and deletion. Several conversations per page, child
 * conversations and read-only workflow histories open explicitly.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the sidebar component owns its conversation, history and proposal state together.
export default function AppAgentSidebar({
  id,
  pageId,
  endpoint,
  threadsBase,
  demo: configuredDemo = false,
  agentName = "Outfitter",
  intro,
  emptyIntro,
  defaultFocus,
  limits,
  demoReply,
  conversationNavigation = false,
  initialOpen = false,
}: {
  id: string;
  pageId: string;
  endpoint: string;
  /** Platform thread routes; defaults to the installation host's. */
  threadsBase?: string;
  demo?: boolean;
  agentName?: string;
  intro: string;
  emptyIntro: string;
  /** The app-wide conversation for a page that selects nothing (shown with `intro`, not `emptyIntro`). */
  defaultFocus?: AgentFocus;
  limits: string;
  demoReply: string;
  /** Hide conversation management and workflow browsing for a focused page assistant. */
  conversationNavigation?: boolean;
  /** Rendered open (the `outfitter-ui` cookie names this sidebar). */
  initialOpen?: boolean;
}) {
  const page = useMemo(() => agentPage(pageId), [pageId]);
  const reopenKey = `outfitter:agent-reopen:${pageId}`;
  const pageClaim = useSyncExternalStore(page.subscribe, page.get, () => empty);
  const claim = useMemo(() => (pageClaim.focus || !defaultFocus ? pageClaim : { ...pageClaim, focus: defaultFocus }), [pageClaim, defaultFocus]);
  // Switchable previews serve an operational package while explicitly selecting read-only fixtures.
  const demo = configuredDemo || (typeof document !== "undefined" &&
    document.querySelector<HTMLMetaElement>('meta[name="outfitter-preview-mode"]')?.content === "demo");
  const prefix = useMemo(() => (typeof location === "undefined" ? "" : mountPrefix(location.pathname)), []);
  const app = useMemo(() => appClient(appEndpoint(prefix, endpoint)), [prefix, endpoint]);
  const threads = useMemo(() => threadClient({ base: threadsBase ?? `${prefix}/api/platform/threads` }), [threadsBase, prefix]);
  /** History pages arrive through the app endpoint; rebase their platform paths onto this mount. */
  const mountEntry = (entry: ThreadEntry): TimelineEntry => ({
    ...entry,
    parts: entry.parts.map((part) => ((part.type === "file" || part.type === "artifact") && part.url ? { ...part, url: threads.url(part.url) } : part)),
  });
  const scope = claim.focus?.project?.id ?? claim.focus?.id;
  const [activated, setActivated] = useState(false);
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [list, setList] = useState<Thread[]>([]);
  const [view, setView] = useState<View>({ kind: "conversation", thread: null });
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [children, setChildren] = useState<Thread[]>([]);
  const [proposals, setProposals] = useState<AppProposal[]>([]);
  const [histories, setHistories] = useState<HistoryGroup[] | null>(null);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<ThreadVisibility>("private");
  const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready");
  const [error, setError] = useState("");
  const [includeDraft, setIncludeDraft] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const lastSend = useRef<{ submissionId: string; text: string; attachments: string[] } | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const thread = view.kind === "conversation" ? view.thread : null;
  // The conversation to return to after browsing a read-only history.
  const lastConversation = useRef<Thread | null>(null);
  if (view.kind === "conversation") lastConversation.current = view.thread;
  const storageKey = scope && info?.cacheKey ? `outfitter:agent-thread:${pageId}:${info.cacheKey}:${scope}` : "";
  const generation = useRef(0);
  const proposalSeq = useRef(0);
  const remember = useCallback((id: string) => {
    try { if (storageKey) sessionStorage.setItem(storageKey, id); } catch {}
  }, [storageKey]);

  const loadThread = useCallback(async (target: Thread | null) => {
    const sequence = ++proposalSeq.current;
    if (!target) {
      setEntries([]);
      setChildren([]);
      setProposals([]);
      return;
    }
    const expected = generation.current;
    const [page, kids, mine] = await Promise.all([
      threads.entries(target.id, { limit: 100 }),
      conversationNavigation ? threads.list({ parent: target.id, limit: 50 }) : Promise.resolve({ threads: [] }),
      app.proposals(target.id),
    ]);
    if (expected !== generation.current || sequence !== proposalSeq.current) return;
    setEntries(page.entries);
    setChildren(kids.threads);
    setProposals(mine.proposals);
    return page.entries;
  }, [threads, app, conversationNavigation]);

  const open = useCallback(async (target: Thread | null) => {
    generation.current++;
    proposalSeq.current++;
    abort.current?.abort();
    setStatus("ready");
    setView({ kind: "conversation", thread: target });
    setError("");
    remember(target?.id ?? "");
    await loadThread(target);
  }, [loadThread, remember]);

  // Load the page's conversations; the last selected one is UI state only.
  useEffect(() => {
    if (!activated) return;
    generation.current++;
    proposalSeq.current++;
    abort.current?.abort();
    setError("");
    setIncludeDraft(false);
    setInfo(null);
    setList([]);
    setView({ kind: "conversation", thread: null });
    setEntries([]);
    setProposals([]);
    setChildren([]);
    setLoaded(false);
    if (!scope || demo) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: loading the context's conversations restores the remembered selection in one effect.
    (async () => {
      const context = await app.context(scope);
      if (cancelled) return;
      setInfo(context);
      let remembered = "";
      try { if (context.cacheKey) remembered = sessionStorage.getItem(`outfitter:agent-thread:${pageId}:${context.cacheKey}:${scope}`) ?? ""; } catch {}
      if (!conversationNavigation) {
        const snapshot = await threads.snapshot({ type: context.type, context: context.context, ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(remembered) ? { preferred: remembered } : {}), limit: 100 });
        if (cancelled) return;
        setView({ kind: "conversation", thread: snapshot.thread });
        setEntries(snapshot.entries);
        try { if (context.cacheKey) sessionStorage.setItem(`outfitter:agent-thread:${pageId}:${context.cacheKey}:${scope}`, snapshot.thread?.id ?? ""); } catch {}
        setLoaded(true);
        // Canonical proposal state can arrive later without blocking typing.
        if (snapshot.thread) {
          const sequence = ++proposalSeq.current;
          const mine = await app.proposals(snapshot.thread.id);
          if (!cancelled && sequence === proposalSeq.current) setProposals(mine.proposals);
        }
      } else {
        const { threads: found } = await threads.list({ type: context.type, context: context.context, limit: 50 });
        if (cancelled) return;
        setList(found);
        const selected = found.find((t) => t.id === remembered) ?? found[0] ?? null;
        setView({ kind: "conversation", thread: selected });
        await loadThread(selected);
      }
      if (!cancelled) setLoaded(true);
    })().catch((e) => {
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
      generation.current++;
      abort.current?.abort();
    };
  }, [scope, demo, activated, app, threads, loadThread, pageId, conversationNavigation]);
  const draftTarget = claim.focus?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft sharing is opt-in again for each selected record.
  useEffect(() => setIncludeDraft(false), [draftTarget]);

  async function refreshList() {
    if (!info) return;
    const { threads: found } = await threads.list({ type: info.type, context: info.context, limit: 50 });
    setList(found);
  }
  async function create(title: string, parent?: { id: string; entryId?: string }) {
    if (!info) throw new Error("Conversation is still loading. Try again.");
    const created = await threads.create({
      type: info.type,
      title: title.slice(0, 120) || "Conversation",
      context: info.context,
      ...(parent ? { parent } : { visibility: info?.privateOnly ? "private" : visibility }),
    });
    if (conversationNavigation) await refreshList();
    return created;
  }
  function pageMetadata() {
    if (!claim.focus) return undefined;
    const value = { focus: claim.focus, ...(includeDraft && claim.draft ? { draft: claim.draft } : {}) };
    // A description from an earlier page is stale once the address changes.
    const { href: _href, ...shown } = claim.view?.href === location.pathname + location.search ? claim.view : { href: "" };
    const metadata = { [claimKey(pageId)]: value, [agentPageKey]: { location: appLocation(prefix), ...shown } };
    if (JSON.stringify(metadata).length > metadataBudget)
      throw new Error(value.draft ? "This unsaved draft is too large to include. Save it first, or send without the draft." : "This page's description is too large to send.");
    return metadata;
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one submission stream: replay, progress, errors and partial output.
  async function stream(target: Thread, input: { submissionId: string; text: string; attachments: string[]; retry?: boolean }) {
    const expected = scope, expectedGeneration = generation.current, controller = new AbortController();
    const current = () => currentScope.current === expected && generation.current === expectedGeneration;
    abort.current = controller;
    setStatus("submitted");
    setError("");
    const userEntry: TimelineEntry = { id: input.submissionId, role: "user", status: "complete", createdAt: Date.now(), recordedAt: null, parts: [{ type: "text", text: input.text }] };
    const before = input.retry ? entries : [...entries, userEntry];
    setEntries(before);
    let answer = "";
    const sentFrom = location.href;
    let finished = false;
    try {
      const metadata = pageMetadata();
      const response = await threads.send(target.id, { ...input, ...(metadata ? { metadata } : {}) } as Parameters<typeof threads.send>[1], controller.signal);
      if (!response.ok) throw new Error((await response.text()).slice(0, 1000));
      if (!(response.headers.get("Content-Type") ?? "").includes("application/json"))
        await readStream(response, (delta) => {
          if (!current()) return;
          answer += delta;
          setStatus("streaming");
          setEntries([...before, { id: `${input.submissionId}:reply`, role: "assistant", status: "partial", createdAt: Date.now(), recordedAt: null, parts: [{ type: "text", text: answer }] }]);
        });
      lastSend.current = null;
      finished = true;
    } catch (e) {
      if (current()) {
        lastSend.current = input;
        setError(controller.signal.aborted ? "Reply stopped. Saved output remains in the conversation." : e instanceof Error ? e.message : "Reply failed");
      }
      return false as const;
    } finally {
      if (current()) {
        setStatus("ready");
        const saved = await loadThread(target).catch(() => undefined);
        if (finished) page.replied();
        // Only after a finished reply, and unless the member has moved on.
        const opened = finished && saved && requestedPage(saved, input.submissionId);
        const href = opened && pageHref(prefix, opened.location, location.href);
        if (href && current() && location.href === sentFrom) {
          // The page swap remounts this panel; reopen it there.
          try { sessionStorage.setItem(reopenKey, "1"); } catch {}
          openPage(href);
        }
      }
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a send validates the draft, uploads files and starts the stream in order.
  async function send({ text, files, effort }: ChatInputDraft): Promise<false | undefined> {
    const expected = generation.current;
    if (!claim.focus) {
      setError(emptyIntro);
      return false;
    }
    if (demo) {
      setEntries((current) => [
        ...current,
        { id: randomId(), role: "user", status: "complete", createdAt: Date.now(), recordedAt: null, parts: [{ type: "text", text }] },
        { id: randomId(), role: "assistant", status: "complete", createdAt: Date.now(), recordedAt: null, parts: [{ type: "text", text: demoReply }] },
      ]);
      return;
    }
    if (!loaded || !info) {
      setError("Conversation is still loading. Try again.");
      return false;
    }
    try {
      pageMetadata();
      const target = thread ?? (await create(text || files[0]?.name || "Conversation"));
      if (expected !== generation.current) return false;
      if (!thread) setView({ kind: "conversation", thread: target });
      remember(target.id);
      const attachments = await Promise.all(files.map((file) => threads.upload(target.id, file)));
      if (expected !== generation.current) return false;
      return stream(target, { submissionId: randomId(), text, attachments: attachments.map((a) => a.id), ...(effort ? { effort } : {}) });
    } catch (e) {
      if (expected === generation.current) setError(e instanceof Error ? e.message : "Send failed; your draft is preserved.");
      return false;
    }
  }
  async function startChild(entry: TimelineEntry) {
    if (!thread) return;
    try {
      const title = window.prompt("Child conversation title", "Follow-up");
      if (!title) return;
      const child = await create(title, { id: thread.id, entryId: entry.id });
      await open(child);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function openRef(ref: ThreadRef, title?: string) {
    setError("");
    try {
      if ("id" in ref) {
        await open(await threads.get(ref.id));
        return;
      }
      const page = await app.history(ref);
      setHistories(null);
      setView({ kind: "history", ref, title: title ?? page.thread.title });
      setEntries(page.entries.map((entry) => mountEntry(entry)));
      setHistoryBefore(page.before);
      setChildren([]);
      setProposals([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function showHistories() {
    setError("");
    try {
      setHistories((await app.histories()).providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function refreshUnresolved(applied: boolean) {
    if (scope) setInfo(await app.context(scope));
    if (applied) page.applied();
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        document.getElementById(id)?.querySelector<HTMLElement>("textarea, [role=textbox]")?.focus();
    });
  }
  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  const renderers = {
    data: {
      [navigatePartName]: (part: Extract<ThreadPart, { type: "data" }>) => {
        const target = navigatePart.safeParse(part.data);
        const href = target.success ? pageHref(prefix, target.data.location, location.href) : null;
        return href && target.success ? <p className="agent-navigation">Opened <a href={href}>{target.data.label}</a></p> : null;
      },
    },
    proposal: (part: Extract<ThreadPart, { type: "proposal" }>) => {
      const proposal = proposalById.get(part.proposalId);
      if (!proposal)
        return <p className="agent-proposal-ref">Proposal {part.label ?? part.proposalId} · {part.status ?? "recorded"} (private to the member who requested it)</p>;
      // A decision entry repeats the link; review controls render once, on the latest mention.
      return <ProposalCard key={`${proposal.id}:${proposal.revision}:${proposal.status}`} proposal={proposal} client={app}
        options={{ ...claim.fieldOptions, ...proposal.fieldOptions }}
        changed={async (applied) => { if (thread) await loadThread(thread); if (applied) page.applied(); }} />;
    },
  };
  const readOnly = view.kind === "history";
  const inspector = useAgentInspector(threads, activated && !demo);
  const shownProposalIds = new Set<string>();
  const messages: Message[] = (readOnly ? [] : entries).map((entry) => ({
    ...asMessage(entry),
    // Show each proposal's review card once (its latest mention), never twice.
    entry: { ...entry, parts: entry.parts },
  }));
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].entry.parts.filter((part) => {
      if (part.type !== "proposal") return true;
      const key = String((part as { proposalId: string }).proposalId);
      if (shownProposalIds.has(key)) return false;
      shownProposalIds.add(key);
      return true;
    });
    messages[i] = { ...messages[i], entry: { ...messages[i].entry, parts } };
  }
  const navigation = conversationNavigation && !demo && scope ? (
    <div className="agent-threads">
      <label>
        Conversation{" "}
        <select
          value={thread?.id ?? ""}
          onChange={(e) => void open(list.find((t) => t.id === e.target.value) ?? null)}
          disabled={status !== "ready" || readOnly}
        >
          <option value="">New conversation…</option>
          {thread && !list.some((t) => t.id === thread.id) ? <option value={thread.id}>{thread.title || "Child conversation"}</option> : null}
          {list.map((t) => (
            <option key={t.id} value={t.id}>{(t.title || "Untitled") + (t.visibility === "organization" ? " · shared" : " · private")}</option>
          ))}
        </select>
      </label>
      {!thread && !readOnly && !info?.privateOnly ? (
        <label className="agent-visibility">
          <input type="checkbox" checked={visibility === "organization"} onChange={(e) => setVisibility(e.target.checked ? "organization" : "private")} />{" "}
          Share with the organization (cannot be changed later)
        </label>
      ) : null}
      {thread ? <p className="agent-thread-scope">{thread.visibility === "organization" ? "Shared with the organization" : "Private to you"}</p> : null}
      {thread?.parent ? <button type="button" className="ui-button ui-button--secondary" onClick={() => void openRef({ id: thread.parent!.id })}>Back to parent conversation</button> : null}
      {children.length ? (
        <details className="agent-children">
          <summary>Child conversations ({children.length})</summary>
          <ul>{children.map((child) => <li key={child.id}><button type="button" className="ui-button ui-button--secondary" onClick={() => void open(child)}>{child.title || "Untitled"}</button></li>)}</ul>
        </details>
      ) : null}
      <button type="button" className="ui-button ui-button--secondary" onClick={() => void showHistories()}>Workflow history</button>
      {histories ? (
        <div className="agent-histories">
          {histories.length ? histories.map((group) => (
            <section key={`${group.installationId}:${group.type}`} aria-label={group.label}>
              <h3>{group.label}</h3>
              {group.error ? <p role="note">{group.error}</p> : null}
              {!group.threads.length && !group.error ? <p>No runs recorded.</p> : null}
              <ul>{group.threads.map((item) => (
                <li key={item.id}><button type="button" className="ui-button ui-button--secondary" onClick={() => void openRef(item.ref, item.title)}>{item.title}</button></li>
              ))}</ul>
            </section>
          )) : <p>No installed app publishes workflow history.</p>}
        </div>
      ) : null}
    </div>
  ) : null;
  const historyView = view.kind === "history" ? (
    <section className="agent-history" aria-label="Workflow history">
      <p><strong>{view.title}</strong></p>
      <p className="agent-thread-scope">Read-only workflow history. Inspecting it cannot run, retry, cancel or change the workflow.</p>
      <button type="button" className="ui-button ui-button--secondary" onClick={() => void open(lastConversation.current)}>Back to conversation</button>
      {historyBefore ? (
        <button type="button" className="ui-button ui-button--secondary" onClick={() => void app.history(view.ref, historyBefore).then((p) => { setEntries((current) => [...p.entries.map((entry) => mountEntry(entry)), ...current]); setHistoryBefore(p.before); }).catch((e) => setError(e.message))}>Load earlier entries</button>
      ) : null}
      <Timeline entries={entries} timestamps="recorded" onOpenThread={(ref, title) => void openRef(ref, title)} label="Workflow history timeline" />
    </section>
  ) : null;
  return (
    <AgentSidebar<Message>
      id={id}
      agent={{ name: agentName }}
      reopenKey={reopenKey}
      initialOpen={initialOpen}
      focus={claim.focus}
      scope={{ intro: claim.focus ? intro : emptyIntro, limits: demo ? "Read-only demo. Replies are scripted; records cannot change." : limits }}
      // Nothing renders until the panel opens: server markup stays free of composer inline styles (CSP).
      conversation={activated && (loaded || demo || !scope) ? {
        id: readOnly ? `history:${threadRefKey((view as { ref: ThreadRef }).ref)}` : (thread?.id ?? `new:${scope ?? "none"}`),
        messages,
        status,
        error: error || undefined,
      } : null}
      input={{ maxLength: 12000, effortEnabled: !demo, attachments: demo ? undefined : imageAttachments }}
      onSend={(draft) => (readOnly ? (setError("Workflow history is read-only."), false) : send(draft))}
      onOpenChange={(isOpen) => { if (isOpen) setActivated(true); }}
      onStop={() => {
        abort.current?.abort();
        const pending = lastSend.current;
        if (thread && pending) void threads.cancel(thread.id, pending.submissionId).catch(() => {});
      }}
      onRetry={thread && lastSend.current && !readOnly ? () => void stream(thread, { ...lastSend.current!, retry: true }) : undefined}
      composerActions={
        <>
          {navigation}
          {!conversationNavigation && thread ? (
            <p className="agent-thread-summary">{thread.visibility === "organization" ? "Shared with the organization" : "Private to you"}</p>
          ) : null}
          {info?.unresolved?.some((proposal) => proposal.threadId !== thread?.id) ? (
            <section className="agent-unresolved" aria-label="Unresolved actions">
              <h3>Unresolved actions</h3>
              {info.unresolved.filter((proposal) => proposal.threadId !== thread?.id).map((proposal) => (
                <ProposalCard key={`${proposal.id}:${proposal.revision}:${proposal.status}`} proposal={proposal} client={app}
                  changed={refreshUnresolved} />
              ))}
            </section>
          ) : null}
          {claim.draft && !demo && !readOnly && (
            <label className="agent-include-draft">
              <input type="checkbox" checked={includeDraft} onChange={(e) => setIncludeDraft(e.target.checked)} /> Include unsaved draft (not saved)
            </label>
          )}
        </>
      }
      renderContent={(message) => (
        <>
          {message.entry.parts.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entry parts are immutable and ordered.
            <TimelinePartView key={index} part={part} renderers={renderers} markdown={message.entry.role === "assistant"} onOpenThread={(ref, title) => void openRef(ref, title)} />
          ))}
          {conversationNavigation && !demo && thread && message.entry.status !== "partial" && ["user", "assistant"].includes(message.entry.role) ? (
            <button type="button" className="agent-child-action" onClick={() => void startChild(message.entry)} disabled={status !== "ready"}>
              Start child conversation
            </button>
          ) : null}
        </>
      )}
      messageClassName={(message) => `timeline-${message.entry.role}`}
      transcriptContent={historyView}
      debugHref={inspector && thread && !readOnly ? sessionDebugHref(thread.id) : undefined}
      debug={inspector ? <AgentDebug threads={threads} threadId={readOnly ? null : (thread?.id ?? null)} href={thread && !readOnly ? sessionDebugHref(thread.id) : undefined}
        revision={`${entries.findLast((entry) => entry.role === "user")?.id}:${JSON.stringify(claim.focus)}:${claim.view?.href ?? ""}`} metadata={pageMetadata} entries={readOnly ? [] : entries} /> : undefined}
    />
  );
}
