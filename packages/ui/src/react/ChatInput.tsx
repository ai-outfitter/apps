import { useEffect, useRef, useState } from "react";
import {
  defaultEffort,
  effortLevels,
  type Effort,
} from "@ai-outfitter/app-sdk/chat-input";
import ChatComposer, {
  type ChatComposerProps,
  type ChatDraft,
} from "./ChatComposer";
import Dictation, { type DictationHandle } from "./Dictation";
import ThinkingEffort from "./ThinkingEffort";
import Icon from "./Icon";

export type ChatInputDraft = ChatDraft & { effort: Effort };
export type ChatInputProps = Omit<
  ChatComposerProps,
  "onSend" | "displayValue"
> & {
  onSend: (draft: ChatInputDraft) => ReturnType<ChatComposerProps["onSend"]>;
  /** Stop speech capture when a containing panel is hidden. */
  active?: boolean;
  effortEnabled?: boolean;
  dictationEnabled?: boolean;
  onEffortChange?: (effort: Effort) => void;
};
const preference = "outfitter:thinking-effort";
/** Full reusable input. Hosts own upload/turn transport; failed sends retain the draft. */
export default function ChatInput({
  onSend,
  onChange,
  value,
  maxLength = 16000,
  disabled = false,
  sending = false,
  readOnly = false,
  actions,
  active = true,
  effortEnabled = false,
  dictationEnabled = true,
  onEffortChange,
  ...props
}: ChatInputProps) {
  const [effort, setEffort] = useState<Effort>(defaultEffort);
  const [dictating, setDictating] = useState(false);
  const [interim, setInterim] = useState("");
  const dictation = useRef<DictationHandle>(null);
  const effortChanged = useRef(onEffortChange);
  effortChanged.current = onEffortChange;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(preference);
      if (effortLevels.includes(saved as Effort)) {
        setEffort(saved as Effort);
        effortChanged.current?.(saved as Effort);
      }
    } catch {}
  }, []);
  const join = (text: string, next: string) =>
    `${text}${text && next && !/\s$/.test(text) ? " " : ""}${next}`.slice(0, maxLength);
  const shown = join(value, interim);
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    if (active || !dictating) return;
    if (interim) onChange(shown);
    dictation.current?.cancel();
    setInterim("");
    setDictating(false);
  }, [active, dictating, interim, shown, onChange]);
  return (
    <ChatComposer
      {...props}
      value={value}
      onChange={onChange}
      maxLength={maxLength}
      disabled={disabled}
      sending={sending}
      readOnly={readOnly || dictating}
      displayValue={shown}
      sendIcon={props.sendIcon ?? <Icon name="send" />}
      stopIcon={props.stopIcon ?? <Icon name="stop" />}
      onSend={(draft) => {
        // Commit interim words before cancel so a rejected upload/send preserves them.
        if (dictating) {
          onChange(draft.text);
          dictation.current?.cancel();
        }
        return onSend({ ...draft, effort });
      }}
      actions={
        <>
          <ThinkingEffort
            enabled={effortEnabled}
            disabled={disabled || sending}
            effort={effort}
            onChange={(next) => {
              setEffort(next);
              onEffortChange?.(next);
              try {
                localStorage.setItem(preference, next);
              } catch {}
            }}
          />
          {dictationEnabled && active && (
            <Dictation
              ref={dictation}
              disabled={disabled || sending || readOnly}
              onBusy={setDictating}
              onInterim={setInterim}
              onTranscript={(text) => {
                current.current = join(current.current, text);
                onChange(current.current);
              }}
            />
          )}
          {actions}
        </>
      }
    />
  );
}
