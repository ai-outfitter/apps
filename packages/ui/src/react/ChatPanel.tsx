import type { ReactNode } from "react";
import "../styles/chat.css";

export interface ChatPanelProps {
  children: ReactNode;
  composer: ReactNode;
  header?: ReactNode;
  label?: string;
  className?: string;
  /** Use sidebar when the conversation accompanies the page's main workspace. */
  variant?: "page" | "sidebar";
}
export default function ChatPanel({
  children,
  composer,
  header,
  label = "Conversation",
  className = "",
  variant = "page",
}: ChatPanelProps) {
  return (
    <section
      className={`ui-chat-panel ui-chat-panel--${variant} ${className}`}
      aria-label={label}
    >
      {header}
      <div
        className="ui-chat-transcript"
        role="log"
        aria-label={`${label} messages`}
        aria-live="polite"
        aria-relevant="additions text"
      >
        {children}
      </div>
      <div className="composer-wrap">{composer}</div>
    </section>
  );
}
