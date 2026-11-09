import type { threadClient } from "@ai-outfitter/app-sdk/threads";
import { useEffect, useState } from "react";

type Threads = Pick<ReturnType<typeof threadClient>, "inspector">;

/** One probe per thread client and page load: the answer only changes with the account. */
const offered = new Map<Threads, Promise<boolean>>();

/** Whether this person may open the session debug page (platform administrators); false until known. */
export function useAgentInspector(threads: Threads | null, enabled = true) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!threads || !enabled) return;
    let active = true;
    let probe = offered.get(threads);
    if (!probe) {
      probe = threads.inspector();
      offered.set(threads, probe);
    }
    void probe.then((value) => { if (active) setAllowed(value); });
    return () => {
      active = false;
    };
  }, [threads, enabled]);
  return allowed;
}

/** `/debug/session` for one conversation: a root page whose central API finds the conversation's owner itself. */
export const sessionDebugHref = (threadId: string) => `/debug/session?${new URLSearchParams({ thread: threadId })}`;
