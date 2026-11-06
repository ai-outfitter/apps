import { z } from "zod";
import { readText } from "@ai-outfitter/connector-core/http";

export class GoogleAuthorizationError extends Response {
  constructor() {
    super("Reconnect this Google account.", { status: 401 });
  }
}

export type GoogleProvider = "gmail" | "google-calendar";
/** The 403 body for a write whose grant lacks its scope, from the stored scopes or from Google. */
export const WRITE_SCOPE_NEEDED = "google-write-scope";
/**
 * What each capability reads: a connection needs these to exist. The read
 * scopes are what routines and chat use; each is also on Google's verified
 * consent screen for this app.
 */
export const readScopes = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly"],
} as const;
/**
 * What a member's own action may write with: a Gmail draft (never sent by
 * Outfitter) or a Calendar event. Asked for with the read scope in one
 * consent; a member may grant reading alone, and then a write asks again.
 */
export const writeScopes = {
  gmail: ["https://www.googleapis.com/auth/gmail.compose"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.events"],
} as const;
/** Everything one connect asks Google for, per capability. */
export const scopes = {
  gmail: ["openid", "email", ...readScopes.gmail, ...writeScopes.gmail],
  "google-calendar": ["openid", "email", ...readScopes["google-calendar"], ...writeScopes["google-calendar"]],
} as const;
export function scopesForProviders(providers: readonly GoogleProvider[]) {
  return [...new Set(providers.flatMap((provider) => scopes[provider]))];
}
/** The requested capabilities whose read scopes were all granted. */
export function grantedProviders(granted: Iterable<string>, requested: readonly GoogleProvider[]) {
  const have = new Set(granted);
  return requested.filter((provider) => readScopes[provider].every((scope) => have.has(scope)));
}
/** Whether a grant lets the capability write (draft mail, create events). */
export function writeGranted(granted: Iterable<string>, provider: GoogleProvider) {
  const have = new Set(granted);
  return writeScopes[provider].every((scope) => have.has(scope));
}
export type GoogleTransport = typeof fetch;
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.literal("Bearer"),
});
/** The status, reasons and message of a Google API error body; token errors are a bare string. */
function googleError(error: unknown) {
  if (typeof error === "string") return { status: error };
  const parsed = z
    .object({
      status: z.string().optional(),
      message: z.string().optional(),
      details: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
      errors: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
    })
    .loose()
    .safeParse(error);
  if (!parsed.success) return null;
  const { status, message, details = [], errors = [] } = parsed.data;
  return {
    status,
    reasons: [...details, ...errors].flatMap((d) => (d.reason ? [d.reason] : [])),
    message: message?.slice(0, 300),
  };
}
export async function googleJson(
  url: string,
  init: RequestInit,
  transport: GoogleTransport = fetch,
) {
  const response = await transport(url, {
    ...init,
    redirect: "manual",
    // A caller's own signal (a tighter budget) still ends the request.
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const tokenEndpoint = url === "https://oauth2.googleapis.com/token";
    let body: { error?: unknown } = {};
    try {
      body = JSON.parse(await readText(response, 1024 * 1024));
    } catch {
      /* Unrecognized provider errors are not revocations. */
    }
    const invalidGrant =
      tokenEndpoint && response.status === 400 && body.error === "invalid_grant";
    // Google's own classification (for example SERVICE_DISABLED for an API not
    // enabled on the project), never mailbox content.
    const error = googleError(body.error);
    console.warn("Google API request failed", {
      endpoint: new URL(url).pathname.split("/").slice(0, 4).join("/"),
      status: response.status,
      error,
    });
    if (tokenEndpoint ? invalidGrant : response.status === 401)
      throw new GoogleAuthorizationError();
    // The token was granted without the scope this call needs: connecting again asks for it.
    if (response.status === 403 && error?.reasons?.some((reason) => /insufficient/i.test(reason)))
      throw new Response(WRITE_SCOPE_NEEDED, { status: 403 });
    throw new Response(
      "Google request failed. Try again or check connector setup.",
      { status: 502 },
    );
  }
  return JSON.parse(await readText(response, 1024 * 1024)) as unknown;
}
export async function googleToken(
  parameters: Record<string, string>,
  transport: GoogleTransport = fetch,
) {
  return tokenSchema.parse(
    await googleJson(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        body: new URLSearchParams(parameters),
      },
      transport,
    ),
  );
}
export async function googleIdentity(
  token: string,
  transport: GoogleTransport = fetch,
) {
  return z
    .object({
      sub: z.string().min(1),
      email: z.email(),
      email_verified: z.literal(true),
    })
    .parse(
      await googleJson(
        "https://openidconnect.googleapis.com/v1/userinfo",
        { headers: { Authorization: `Bearer ${token}` } },
        transport,
      ),
    );
}
