import { createContext, useCallback, useContext, useRef } from "react";

/** Sign-in providers configured on this host, offered in order. */
export type SignUpProvider = "google" | "github";

/**
 * Where a UI tool renders. Signed out (the homepage chat), actions start
 * sign-up from the chat (each configured provider directly, or email on the
 * sign-up page), which saves the conversation and returns to it; signed in,
 * they act on this chat. In both, `send` posts the member's answer as their
 * next message; signed in, a card's `intent` travels with it as structured data.
 *
 * `platformURL` turns a platform route (`/api/routines`, `/workflows/…/runs/…`)
 * into the URL a card fetches, posts to or links. Platform pages leave it
 * unset (the path itself); an app mounted under the platform, whose browser
 * adapter rewrites root-relative URLs into its own mount, supplies one that
 * reaches the platform origin.
 */
export const ChatComponentContext = createContext<
  | {
      signedIn: false;
      signupHref: string;
      providers: readonly SignUpProvider[];
      /** Email and password sign-up is enabled on this host. */
      emailSignup: boolean;
      signupReturnTo: string;
      send: (text: string) => void;
      busy: boolean;
      /** Static preview transcript: actions must not mutate a chat or start OAuth. */
      previewFixture?: boolean;
      platformURL?: (path: string) => string;
    }
  | {
      signedIn: true;
      chatPath: string;
      // Method syntax: a host's `send` may accept only its own intent names.
      send(text: string, intent?: string): void;
      busy: boolean;
      platformURL?: (path: string) => string;
    }
  | null
>(null);

const samePath = (path: string) => path;

/**
 * The context's `platformURL`, or the path itself outside a provider. The
 * returned function stays the same across renders, so fetch callbacks and
 * polling effects that depend on it do not restart when the provider re-renders.
 */
export function usePlatformURL(): (path: string) => string {
  const current = useContext(ChatComponentContext)?.platformURL ?? samePath;
  const latest = useRef(current);
  latest.current = current;
  return useCallback((path: string) => latest.current(path), []);
}
