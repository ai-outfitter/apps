import type { AgentFocus } from "@ai-outfitter/ui/agent-focus";
import AgentSidebar, { AgentMessageText } from "@ai-outfitter/ui/react/AgentSidebar";
import { useEffect, useState } from "react";
import type { AgentScope } from "../fixtures";
import { SELECT_EVENT, selectedPriority } from "../scripts/selection";

type Message = { id: string; role: "user" | "assistant"; parts: { type: "text"; text: string }[] };
const text = (id: string, role: Message["role"], body: string): Message => ({ id, role, parts: [{ type: "text", text: body }] });

interface Props {
  panel: string;
  scopes: AgentScope[];
}

/**
 * Forerunner beside the day view, scoped to the selected stone. Replies are
 * the stone's scripted fixture dialogue, held only in memory: there is no
 * agent route, so nothing is inferred, read from a provider, sent or stored.
 */
export default function ForerunnerAgent({ panel, scopes }: Props) {
  const [selected, setSelected] = useState(scopes[0].id);
  // Suggestion ids asked per stone, in order; the transcript is rebuilt from them.
  const [asked, setAsked] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const current = selectedPriority();
    if (current) setSelected(current);
    const follow = (event: Event) => setSelected((event as CustomEvent<string>).detail);
    document.addEventListener(SELECT_EVENT, follow);
    return () => document.removeEventListener(SELECT_EVENT, follow);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a notice belongs to the stone it was shown for.
  useEffect(() => setNotice(undefined), [selected]);

  const scope = scopes.find((s) => s.id === selected) ?? scopes[0];
  const focus: AgentFocus = { kind: "forerunner-stone", id: scope.id, label: scope.title };
  const messages = [
    text(`${scope.id}.briefing`, "assistant", scope.dialogue.briefing),
    ...(asked[scope.id] ?? []).flatMap((id) => {
      const suggestion = scope.dialogue.suggestions.find((s) => s.id === id);
      return suggestion ? [text(`${id}.prompt`, "user", suggestion.prompt), text(`${id}.reply`, "assistant", suggestion.reply)] : [];
    }),
  ];
  const remaining = scope.dialogue.suggestions.filter((s) => !asked[scope.id]?.includes(s.id));

  return (
    <AgentSidebar<Message>
      id={panel}
      agent={{ name: "Forerunner", icon: "spark" }}
      focus={focus}
      scope={{
        intro: "Ask about the selected stone.",
        limits: "Forerunner answers from this view's records. It cannot read mail or calendars, send, schedule or decide for you.",
      }}
      conversation={{
        // Keep the composer mounted across selections so its built-in stale-focus
        // guard asks the visitor to keep or discard an unsent draft.
        id: "forerunner-day",
        messages,
        status: "ready",
        notice: notice ?? "Scripted preview: Forerunner uses only these example records and suggested replies. No inbox or calendar is connected.",
      }}
      onSend={({ text: prompt, focus: about }) => {
        const target = scopes.find((s) => s.id === about?.id);
        const suggestion = target?.dialogue.suggestions.find((s) => s.prompt === prompt);
        if (!target || !suggestion) {
          setNotice("Forerunner can answer only the suggested questions here; it has no agent connection.");
          return false;
        }
        setNotice(undefined);
        setAsked((all) => ({ ...all, [target.id]: [...(all[target.id] ?? []), suggestion.id] }));
      }}
      renderContent={(message, { index, messages: all, send }) => (
        <>
          <AgentMessageText message={message} />
          {index === all.length - 1 && remaining.length ? (
            <ul className="forerunner-suggestions" aria-label="Suggested questions">
              {remaining.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => send(s.prompt)}>
                    {s.prompt}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    />
  );
}
