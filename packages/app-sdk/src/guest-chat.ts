import { z } from "zod";

/**
 * The guest (signed-out) chat transport: a typed client for the platform's
 * EXISTING guest endpoints. Admission, rate limits, the guest token and
 * session store, accounting and the signup claim all stay in the platform;
 * the browser sends only the visitor's new text. Use it with the AI SDK:
 *
 * ```ts
 * transport: new DefaultChatTransport(guestChatTransport({ fixture, onResponse }))
 * ```
 */

/** Guest reply endpoint (POST, same-origin JSON, answers an AI SDK UI message stream). */
export const guestChatPath = "/api/anonymous-chat";
/** Signup claim endpoint: a same-origin form POST after sign-in, answering a 303 redirect. */
export const guestClaimPath = "/api/anonymous-chat/claim";
/** Diagnostic header carrying the reply's context estimate (local development only). */
export const guestContextHeader = "X-Outfitter-Chat-Context";
/** The platform's guest message bound; the server enforces it again. */
export const guestTextCharacters = 2000;

/** The request body: only the new text (the server keeps the transcript), and an optional named example. */
export const guestTurnBody = z.strictObject({
  text: z.string().max(guestTextCharacters),
  fixture: z.string().max(64).optional(),
});
export type GuestTurnBody = z.infer<typeof guestTurnBody>;

/** The diagnostic context estimate, when the platform reports one. Display only. */
export const guestChatContext = z.looseObject({
  model: z.string().optional(),
  provider: z.string().optional(),
  phase: z.string().optional(),
});
export type GuestChatContext = z.infer<typeof guestChatContext>;

/** How a guest reply answered: what the page should do next. */
export type GuestOutcome = "ok" | "signed-in" | "limit" | "unavailable" | "refused" | "retry";
export function guestOutcome(status: number): GuestOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 409) return "signed-in";
  if (status === 429) return "limit";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "refused";
  return "retry";
}

type UIMessageLike = { role: string; parts: readonly { type: string; text?: string }[] };

/** The newest user message's text, as the guest endpoint takes it. */
export function guestTurnText(messages: readonly UIMessageLike[]) {
  const last = messages.filter((message) => message.role === "user").at(-1);
  return last?.parts.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n") ?? "";
}

/**
 * Options for `new DefaultChatTransport(...)` over the guest endpoint. The
 * SDK has no AI SDK dependency, so this returns the transport's options.
 * `onResponse` sees each response (its status decides gates and retries);
 * `onContext` receives the parsed diagnostic context header when present.
 */
export function guestChatTransport(options: {
  fixture?: string;
  base?: string;
  fetch?: typeof fetch;
  /** Before each request (e.g. clear the last response status). */
  onRequest?: () => void;
  onResponse?: (response: Response, outcome: GuestOutcome) => void;
  onContext?: (context: GuestChatContext) => void;
} = {}) {
  const fetcher = options.fetch ?? fetch;
  return {
    api: `${options.base ?? ""}${guestChatPath}`,
    credentials: "same-origin" as const,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      options.onRequest?.();
      const response = await fetcher(input, init);
      options.onResponse?.(response, guestOutcome(response.status));
      const header = response.headers.get(guestContextHeader);
      if (header && options.onContext) {
        try {
          const parsed = guestChatContext.safeParse(JSON.parse(header));
          if (parsed.success) options.onContext(parsed.data);
        } catch {}
      }
      return response;
    }) as typeof fetch,
    // Over-long text still goes to the server, whose refusal the page shows.
    prepareSendMessagesRequest: ({ messages }: { messages: readonly UIMessageLike[] }) => ({
      body: { text: guestTurnText(messages), ...(options.fixture ? { fixture: options.fixture } : {}) } satisfies GuestTurnBody,
    }),
  };
}
