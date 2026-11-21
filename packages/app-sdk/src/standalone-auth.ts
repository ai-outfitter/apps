import { type AppIdentity, identityHeaders, identityHeaderValues } from "./server";
import type { StandaloneMember } from "./standalone-host";

// Sign-in for an app running standalone (docs/standalone-apps.md): Google
// OpenID Connect, or a name-and-email form only under `astro dev`. A signed
// session cookie stands in for the platform's session, and the middleware
// turns it into the same forwarded identity headers the platform sends, so
// the app's own code cannot tell the two apart.

export const sessionCookie = "outfitter_session";
export const oauthCookie = "outfitter_oauth";
const sessionSeconds = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

export type StandaloneSession = StandaloneMember & { exp: number };

export type StandaloneAuthConfig = {
  /** HMAC key of session cookies (`SESSION_SECRET`). */
  secret: string;
  google?: { clientId: string; clientSecret: string };
  /** Who may sign in with Google: exact addresses, or whole domains. */
  allowedEmails: string[];
  allowedDomains: string[];
  /** Owners of the app; when empty, everyone who may sign in is one. */
  adminEmails: string[];
  /** The one organization this deployment is (`ORGANIZATION`), and its installation. */
  organization: string;
  installation: string;
};

const list = (value: unknown) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** The auth settings from the Worker's environment. Outside `astro dev` a session secret is required. */
export function standaloneAuthConfig(env: Record<string, unknown>, app: string, dev: boolean): StandaloneAuthConfig | string {
  const secret = String(env.SESSION_SECRET ?? "") || (dev ? "outfitter-standalone-dev-only" : "");
  if (secret.length < 16) return "Set SESSION_SECRET (at least 16 characters) to sign people in.";
  const clientId = String(env.GOOGLE_CLIENT_ID ?? "");
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET ?? "");
  return {
    secret,
    ...(clientId && clientSecret ? { google: { clientId, clientSecret } } : {}),
    allowedEmails: list(env.ALLOWED_EMAILS),
    allowedDomains: list(env.ALLOWED_DOMAINS),
    adminEmails: list(env.ADMIN_EMAILS),
    organization: String(env.ORGANIZATION ?? "") || app,
    installation: app,
  };
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unbase64url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

/** `payload.signature`, both base64url. */
export async function sign(secret: string, value: unknown) {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  return `${payload}.${await hmac(secret, payload)}`;
}

/** The signed value, or undefined when the signature or expiry fails. */
export async function verify<T extends { exp: number }>(secret: string, token: string | undefined, now = Date.now()): Promise<T | undefined> {
  const [payload, signature, extra] = (token ?? "").split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = await hmac(secret, payload);
  if (expected.length !== signature.length) return undefined;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  if (difference) return undefined;
  try {
    const value = JSON.parse(new TextDecoder().decode(unbase64url(payload))) as T;
    return typeof value.exp === "number" && value.exp * 1000 > now ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export function cookie(request: Request, name: string, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function sessionCookieFor(request: Request, secret: string, member: StandaloneMember, now = Date.now()) {
  const value = await sign(secret, { ...member, exp: Math.floor(now / 1000) + sessionSeconds } satisfies StandaloneSession);
  return cookie(request, sessionCookie, value, sessionSeconds);
}

/** A same-origin path to return to after sign-in; anything else is `/`. */
export function returnPath(value: string | null | undefined) {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && !value.startsWith("/login") ? value : "/";
}

/** Whether a verified Google account may sign in. */
export function admitted(config: StandaloneAuthConfig, email: string, hostedDomain?: string) {
  const address = email.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return (
    config.allowedEmails.includes(address) ||
    config.adminEmails.includes(address) ||
    config.allowedDomains.includes(domain) ||
    Boolean(hostedDomain && config.allowedDomains.includes(hostedDomain.toLowerCase()))
  );
}

/** The forwarded identity of a signed-in member of this deployment's one organization. */
export function standaloneIdentity(config: StandaloneAuthConfig, member: StandaloneMember): Omit<AppIdentity, "canEdit"> {
  const owner = !config.adminEmails.length || config.adminEmails.includes(member.email.toLowerCase());
  return {
    userId: member.id,
    organizationId: config.organization,
    owner: { kind: "organization", id: config.organization },
    installationId: config.installation,
    role: owner ? "owner" : "member",
    access: owner ? "admin" : "write",
  };
}

/** The request as the platform would forward it: every incoming identity header
 * dropped, then the member's own set. */
export function forwardedRequest(request: Request, identity: Omit<AppIdentity, "canEdit">) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("x-outfitter-")) headers.delete(name);
  for (const [name, value] of Object.entries(identityHeaderValues(identity))) if (value) headers.set(name, value);
  // The owner header alone names the owner kind; an empty organization would contradict it.
  if (!headers.get(identityHeaders.organization)) headers.delete(identityHeaders.organization);
  return new Request(request, { headers });
}

const googleAuthorize = "https://accounts.google.com/o/oauth2/v2/auth";
const googleToken = "https://oauth2.googleapis.com/token";

async function challenge(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** Redirect to Google with state and PKCE kept in a short signed cookie. */
export async function googleStart(request: Request, config: StandaloneAuthConfig & { google: NonNullable<StandaloneAuthConfig["google"]> }) {
  const url = new URL(request.url);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const exp = Math.floor(Date.now() / 1000) + 600;
  const target = new URL(googleAuthorize);
  target.search = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: `${url.origin}/login/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  const headers = new Headers({ Location: target.toString() });
  headers.append("Set-Cookie", cookie(request, oauthCookie, await sign(config.secret, { state, verifier, returnTo: returnPath(url.searchParams.get("returnTo")), exp }), 600));
  return new Response(null, { status: 302, headers });
}

/** Google's answer: the member it signed in and where to go, or a reason to refuse. */
export async function googleFinish(
  request: Request,
  config: StandaloneAuthConfig & { google: NonNullable<StandaloneAuthConfig["google"]> },
  fetcher: typeof fetch = fetch,
): Promise<{ member: StandaloneMember; returnTo: string } | { refused: string }> {
  const url = new URL(request.url);
  const pending = await verify<{ state: string; verifier: string; returnTo: string; exp: number }>(config.secret, readCookie(request, oauthCookie));
  if (!pending || pending.state !== url.searchParams.get("state")) return { refused: "That sign-in expired. Try again." };
  const code = url.searchParams.get("code");
  if (!code) return { refused: "Google did not sign you in." };
  const response = await fetcher(googleToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: `${url.origin}/login/google/callback`,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok) return { refused: "Google did not confirm the sign-in. Try again." };
  // Received directly from Google's token endpoint over TLS, so the ID token's
  // claims are trusted without a signature check (OpenID Connect Core 3.1.3.7).
  const { id_token: idToken } = (await response.json()) as { id_token?: string };
  let claims: { iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean; name?: string; hd?: string };
  try {
    claims = JSON.parse(new TextDecoder().decode(unbase64url(String(idToken).split(".")[1] ?? "")));
  } catch {
    return { refused: "Google did not confirm the sign-in. Try again." };
  }
  if (
    !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss ?? "") ||
    claims.aud !== config.google.clientId ||
    !claims.exp ||
    claims.exp * 1000 < Date.now() ||
    !claims.sub ||
    !claims.email ||
    claims.email_verified !== true
  )
    return { refused: "Google did not confirm a verified email address." };
  if (!config.allowedEmails.length && !config.allowedDomains.length && !config.adminEmails.length)
    return { refused: "No one may sign in yet. Set ALLOWED_EMAILS, ALLOWED_DOMAINS or ADMIN_EMAILS." };
  if (!admitted(config, claims.email, claims.hd)) return { refused: `${claims.email} may not sign in here.` };
  return {
    member: { id: `google:${claims.sub}`, email: claims.email, name: claims.name || claims.email },
    returnTo: pending.returnTo,
  };
}
