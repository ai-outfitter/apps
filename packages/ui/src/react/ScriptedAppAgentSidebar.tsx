import { type AgentFocus, agentPage, type PageClaim } from "@ai-outfitter/app-sdk/agent-context";
import AgentSidebar, { type AgentMessage } from "./AgentSidebar";
import { useMemo, useState, useSyncExternalStore } from "react";

const empty: PageClaim = { focus: null };

/**
 * The demo build's agent sidebar: the same panel, page focus and copy as the
 * operational AppAgentSidebar, answering every message with the scripted reply.
 * It holds no transport, so the demo bundle makes no platform or app request
 * (tests/demo-package-assets.test.ts). App configs select this component at
 * build time using the shared scriptedAgentResolution helper.
 */
export default function ScriptedAppAgentSidebar({
  id,
  pageId,
  agentName = "Outfitter",
  intro,
  emptyIntro,
  defaultFocus,
  limits,
  demoReply,
}: {
  id: string;
  pageId: string;
  /** Accepted for prop parity with AppAgentSidebar; the demo never calls it. */
  endpoint?: string;
  demo?: boolean;
  agentName?: string;
  intro: string;
  emptyIntro: string;
  /** The app-wide conversation for a page that selects nothing (shown with `intro`, not `emptyIntro`). */
  defaultFocus?: AgentFocus;
  limits: string;
  demoReply: string;
}) {
  const page = useMemo(() => agentPage(pageId), [pageId]);
  const pageClaim = useSyncExternalStore(page.subscribe, page.get, () => empty);
  const claim = useMemo(() => (pageClaim.focus || !defaultFocus ? pageClaim : { ...pageClaim, focus: defaultFocus }), [pageClaim, defaultFocus]);
  const [activated, setActivated] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [error, setError] = useState("");
  const text = (role: AgentMessage["role"], value: string) => ({
    id: crypto.randomUUID(),
    role,
    parts: [{ type: "text", text: value }],
  });
  return (
    <AgentSidebar
      id={id}
      agent={{ name: agentName }}
      focus={claim.focus}
      scope={{ intro: claim.focus ? intro : emptyIntro, limits }}
      // Nothing renders until the panel opens: server markup stays free of composer inline styles (CSP).
      conversation={
        activated
          ? { id: "demo", messages, status: "ready", error: error || undefined }
          : null
      }
      input={{ maxLength: 12000, effortEnabled: false }}
      onOpenChange={(open) => {
        if (open) setActivated(true);
      }}
      onSend={({ text: sent }) => {
        if (!claim.focus) {
          setError(emptyIntro);
          return false;
        }
        setError("");
        setMessages((current) => [
          ...current,
          text("user", sent),
          text("assistant", demoReply),
        ]);
        return undefined;
      }}
    />
  );
}
