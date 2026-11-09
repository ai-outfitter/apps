/**
 * Interface preferences the server renders on the first paint, kept in one small
 * first-party cookie (`outfitter-ui`) so a page arrives as the member left it, such
 * as with its agent sidebar open. Display state only: never identity, authority or
 * content. Add a key here for each new preference (a theme, a collapsed panel).
 */
export const UI_COOKIE = "outfitter-ui";
/** Apps never receive cookies: the platform forwards the parsed, re-encoded value to an
 * app's pages in this header, and `requestUiPreferences` reads it there. */
export const uiPreferencesHeader = "x-outfitter-ui";

export type UiPreferences = {
  /** The `id` of the agent sidebar left open, if any. */
  agent?: string;
  /** The agent sidebar's width in CSS pixels, when the member resized it. */
  agentWidth?: number;
};

const MAX_AGE = 60 * 60 * 24 * 365;
const name = /^[A-Za-z0-9_-]{1,64}$/;

/** The preferences in a cookie value; unknown or malformed values are ignored. */
export function parseUiPreferences(value: string | undefined | null): UiPreferences {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
    const width = parsed.agentWidth;
    return {
      ...(typeof parsed.agent === "string" && name.test(parsed.agent) ? { agent: parsed.agent } : {}),
      ...(typeof width === "number" && Number.isInteger(width) && width >= 240 && width <= 2000 ? { agentWidth: width } : {}),
    };
  } catch {
    return {};
  }
}

/** The preferences from a request's Cookie header. */
export function uiPreferences(cookieHeader: string | null | undefined): UiPreferences {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === UI_COOKIE) return parseUiPreferences(rest.join("="));
  }
  return {};
}

/** Change one preference in the browser; `undefined` removes it. */
export function setUiPreference<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) {
  if (typeof document === "undefined") return;
  const next = { ...uiPreferences(document.cookie), [key]: value };
  if (value === undefined) delete next[key];
  const secure = location.protocol === "https:" ? "; Secure" : "";
  // biome-ignore lint/suspicious/noDocumentCookie: one small display cookie; the Cookie Store API is not in every supported browser.
  document.cookie = `${UI_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`;
}

/** The preferences re-encoded from their known keys only, for forwarding to an app. */
export function encodeUiPreferences(preferences: UiPreferences) {
  return encodeURIComponent(JSON.stringify(preferences));
}

/** A page request's preferences: the platform's forwarded header, else the cookie. */
export function requestUiPreferences(request: Request): UiPreferences {
  const forwarded = request.headers.get(uiPreferencesHeader);
  return forwarded !== null ? parseUiPreferences(forwarded) : uiPreferences(request.headers.get("cookie"));
}
