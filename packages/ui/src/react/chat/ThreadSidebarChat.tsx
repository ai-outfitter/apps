import { secureId } from "./secure-id";
import { useChat } from "@ai-sdk/react";
import { defaultEffort, imageAttachments } from "@ai-outfitter/app-sdk/chat-input";
import { type ThreadEntry, threadClient } from "@ai-outfitter/app-sdk/threads";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import AgentSidebar from "../AgentSidebar";
import Icon from "../Icon";
import Markdown from "../Markdown";

/** The owner's default Chat, as the platform's `/api/default-apps/<mount>` answers it. */
type ChatHost = { installationId: string; type: string; chatPath: string };
type Selected = { id: string; messages: UIMessage[]; persisted: boolean };
const fresh = (): Selected => ({ id: secureId(), messages: [], persisted: false });
// The chat useChat holds until the saved conversation loads; it never sends.
const PENDING = "pending";

/** A saved entry as the panel shows it: text and images; cards open in full chat. */
function uiMessage(entry: ThreadEntry): UIMessage {
  const parts: UIMessage["parts"] = [];
  for (const part of entry.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "file") parts.push({ type: "file", mediaType: part.mediaType, filename: part.filename, url: part.url });
    else if (part.type === "tool-call") parts.push({ type: `tool-${part.name}`, toolCallId: part.callId, state: "output-available", input: part.input, output: null } as UIMessage["parts"][number]);
  }
  return { id: entry.id, role: entry.role === "user" ? "user" : "assistant", parts };
}

/** The owner's default Chat, provisioned on first use by the platform. */
async function chatHost(hostURL: string): Promise<ChatHost> {
  const response = await fetch(hostURL, { method: "POST", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as ChatHost;
}

/** The conversation this panel last saved, when it is still this member's own conversation; else null. */
async function savedConversation(found: ChatHost, chatKey: string, userId: string): Promise<Selected | null> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(chatKey);
  } catch {}
  if (!saved) return null;
  const threads = threadClient({ installationId: found.installationId });
  const thread = await threads.get(saved).catch(() => null);
  // Deleted, from another account or scope, or not a conversation: start over quietly.
  if (thread?.type !== found.type || thread.createdBy !== userId) return null;
  const { entries } = await threads.entries(saved, { limit: 200 });
  return { id: saved, persisted: true, messages: entries.filter((entry) => entry.role === "user" || entry.role === "assistant").map(uiMessage) };
}

/**
 * "Ask Outfitter" beside a platform page: the shared agent sidebar over the
 * owner's default Chat conversations (private, the Chat app's
 * `chat.conversation` threads). Turns go to the platform's thread routes for
 * that installation, so Chat's own reply policy, tools and history apply; the
 * panel renders text and images, and offers Open in full chat for cards. It
 * has no focus: Outfitter does not see the page it sits beside.
 */
export default function ThreadSidebarChat({ id, userId, scopeKey, hostURL, label = "Outfitter" }: {
  /** The panel's id, which its header toggle controls. */
  id: string;
  userId: string;
  /** The owner scope (an organization id, or "personal"): switching it switches conversations. */
  scopeKey: string;
  /** Where the platform answers (and provisions) this owner's default Chat. */
  hostURL: string;
  label?: string;
}) {
  // Pages without the ClientRouter reload on navigation; these keys carry the
  // panel's state and conversation to the next page.
  const chatKey = `outfitter:sidebar-chat:${userId}:${scopeKey}`;
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<ChatHost | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [notice, setNotice] = useState("");
  const effort = useRef(defaultEffort);
  const current = useRef(selected);
  current.current = selected;
  const client = useMemo(() => (host ? threadClient({ installationId: host.installationId }) : null), [host]);
  const stored = useRef<Promise<unknown> | null>(null);

  function forget() {
    try {
      localStorage.removeItem(chatKey);
    } catch {}
  }

  // The first open finds the owner's Chat, then loads the conversation this panel last saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once, on first open.
  useEffect(() => {
    if (!open || selected) return;
    let active = true;
    (async () => {
      const found = await chatHost(hostURL);
      if (!active) return;
      setHost(found);
      const restored = await savedConversation(found, chatKey, userId);
      if (!active) return;
      if (!restored) {
        forget();
        return setSelected(fresh());
      }
      stored.current = Promise.resolve();
      setSelected(restored);
    })().catch(() => {
      if (!active) return;
      setNotice("Could not load your last conversation. This is a new chat.");
      setSelected(fresh());
    });
    return () => {
      active = false;
    };
  }, [open]);

  /** Stores the conversation before its first turn or upload: the member's own, private. */
  function ready() {
    const chat = current.current;
    if (!chat || !client || !host) return Promise.reject(new Error("Chat is not ready yet."));
    stored.current ??= client.create({ id: chat.id, type: host.type, visibility: "private" }).then(() => {
      try {
        localStorage.setItem(chatKey, chat.id);
      } catch {}
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
    generateId: () => secureId(),
    transport: new DefaultChatTransport({
      api: "/api/platform/threads",
      fetch: async (input, init) => {
        await readyRef.current();
        return fetch(input, init);
      },
      prepareSendMessagesRequest: ({ id: threadId, messages: sent, trigger }) => {
        const message = sent.filter((m) => m.role === "user").at(-1);
        return {
          api: client?.submissionsURL(threadId) ?? "/api/platform/threads",
          body: {
            submissionId: message?.id,
            text: (message?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            attachments: (message?.parts ?? []).flatMap((part) => (part.type === "file" ? [part.url.slice(part.url.lastIndexOf("/") + 1).split("?")[0]] : [])),
            effort: effort.current,
            ...(trigger === "regenerate-message" ? { retry: true } : {}),
          },
        };
      },
    }),
  });
  const busy = status === "streaming" || status === "submitted";
  const fullChat = host && selected?.persisted ? `${host.chatPath}/c/${selected.id}` : null;

  return (
    <AgentSidebar
      id={id}
      agent={{ name: label }}
      focus={null}
      scope={{
        intro: "Ask Outfitter anything while you work. Chats here are saved in Chat with your others, private to you.",
        limits: "Outfitter can't see or change this page.",
      }}
      conversation={selected ? { id: selected.id, messages, status, error: error ? error.message || "Could not send your message." : undefined, notice } : null}
      openStorageKey={`${chatKey}:open`}
      onOpenChange={setOpen}
      input={{ attachments: imageAttachments, effortEnabled: true, onEffortChange: (next) => { effort.current = next; } }}
      onSend={async ({ text, files }) => {
        if (busy || !selected || !client) return false;
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
      onNewConversation={() => {
        forget();
        stored.current = null;
        setNotice("");
        setSelected(fresh());
      }}
      actions={fullChat ? (
        <a className="agent-sidebar-action" href={fullChat} title="Open in full chat" data-astro-reload>
          <Icon name="arrow" size={18} />
          <span className="visually-hidden">Open in full chat</span>
        </a>
      ) : null}
      renderContent={(message) => (
        <>
          {message.parts.map((part, i) =>
            part.type === "text" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: message parts have no id and never reorder.
              <Markdown key={i}>{part.text}</Markdown>
            ) : part.type === "file" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: message parts have no id and never reorder.
              <img key={i} className="message-attachment" src={part.url} alt={part.filename || ""} />
            ) : null,
          )}
          {/* Chat's cards and tool results render in Chat; the panel links there once. */}
          {message.role === "assistant" && message.parts.some((part) => part.type.startsWith("tool-") && "state" in part && part.state === "output-available") ? (
            <p className="agent-sidebar-card-note">
              {fullChat ? <a href={fullChat} data-astro-reload>Open in full chat</a> : "Open in full chat"} to see the cards in this reply.
            </p>
          ) : null}
        </>
      )}
    />
  );
}
