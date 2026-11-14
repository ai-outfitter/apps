import type { UIMessage } from "ai";

// Reading UI tool cards out of a chat transcript. The host names its tools and
// its "Not now" answer; these helpers only walk the messages.

/** A message's tool parts, rendered after its text and files. */
export function toolParts(message: UIMessage) {
  return message.parts.filter((part) => part.type.startsWith("tool-"));
}

/** The latest unanswered task question (`toolName`) belongs beside the composer, not in the log. */
export function activeTaskQuestion(messages: UIMessage[], toolName = "propose_tasks"): UIMessage["parts"][number] | null {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  for (let index = messages.length - 1; index > lastUser; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const question = message.parts.findLast((part) => part.type === `tool-${toolName}` && "state" in part && part.state === "output-available");
    if (question) return question;
  }
  return null;
}

/** A member message that only answered the connect card with Not now (`isConnectLater`); shown muted. */
export const connectLaterMessage = (message: UIMessage, isConnectLater: (text: string) => boolean) =>
  message.role === "user" && isConnectLater(message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));

/**
 * Whether the first Not now after the connect card (`connectToolName`) was
 * sent, which the server does not count against the free messages.
 */
export function connectLaterFree(messages: UIMessage[], connectToolName: string, isConnectLater: (text: string) => boolean) {
  const card = messages.findIndex((m) => m.parts.some((part) => part.type === `tool-${connectToolName}`));
  return card >= 0 && messages.slice(card + 1).some((message) => connectLaterMessage(message, isConnectLater));
}

/** The follow-up after connecting services, shared by Chat and its sidebar. */
export const connectedMessage = (services: string[], gmail: boolean) => ({
  text: `I connected ${services.join(" and ")}. ${gmail ? "Show my work profile." : "Find my recurring tasks."}`,
  intent: gmail ? "work_profile" : "discover",
});
