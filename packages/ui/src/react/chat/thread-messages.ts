import type { ThreadEntry } from "@ai-outfitter/app-sdk/threads";
import type { UIMessage } from "ai";

/** What the platform recorded in a member's sidebar thread (src/lib/sidebar-activity.ts). */
export type SidebarActivity = { kind: "run" | "routine"; title: string; status: "complete" | "failed" | "created"; href: string; summary?: string };
const activityOf = (entry: ThreadEntry) => {
  const part = entry.parts.find((item) => item.type === "data" && item.name === "platform.activity");
  const data = part?.type === "data" ? (part.data as Partial<SidebarActivity> | null) : null;
  return data && typeof data.title === "string" && typeof data.href === "string" && data.href.startsWith("/") ? (data as SidebarActivity) : null;
};
/** Entries the panel shows: the conversation, and the activity the platform recorded in it. */
export const shownEntry = (entry: ThreadEntry) => entry.role === "user" || entry.role === "assistant" || (entry.role === "event" && Boolean(activityOf(entry)));

/** A saved entry as the panel shows it: an activity card, or text and images; cards open in full chat. */
export function uiMessage(entry: ThreadEntry): UIMessage {
  const activity = entry.role === "event" ? activityOf(entry) : null;
  return activity ? { id: entry.id, role: "assistant", parts: [], metadata: { status: entry.status, activity, at: entry.createdAt } } : conversationMessage(entry);
}

function conversationMessage(entry: ThreadEntry): UIMessage {
  const parts: UIMessage["parts"] = [];
  const results = new Map(entry.parts.flatMap((part) => part.type === "tool-result" ? [[part.callId, part] as const] : []));
  for (const part of entry.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "file") parts.push({ type: "file", mediaType: part.mediaType, filename: part.filename, url: part.url });
    else if (part.type === "tool-call") {
      const result = results.get(part.callId);
      parts.push({ type: `tool-${part.name}`, toolCallId: part.callId, input: part.input, ...(result ? result.error ? { state: "output-error", errorText: result.error } : { state: "output-available", output: result.output } : { state: "input-available" }) } as UIMessage["parts"][number]);
    }
  }
  return { id: entry.id, role: entry.role === "user" ? "user" : "assistant", parts, metadata: { status: entry.status } };
}

