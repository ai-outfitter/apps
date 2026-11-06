import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

type Availability =
  "available" | "downloadable" | "downloading" | "unavailable";
type Options = { langs: string[]; processLocally: true };
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<SpeechResult>;
      }) => void)
    | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = {
  new (): Recognition;
  available?: (options: Options) => Promise<Availability>;
  install?: (options: Options) => Promise<boolean>;
};

function recognitionErrorMessage(error: string, detail?: string) {
  const explanation =
    detail === "User permission check has failed"
      ? "Speech access is blocked for this tab. Close this tab and reopen Outfitter, then try again."
      : error === "service-not-allowed"
        ? "The browser’s speech service is blocked or unavailable, even if microphone access is allowed."
        : error === "not-allowed"
          ? "The browser blocked speech access. If permissions are enabled, close this tab and reopen Outfitter."
          : error === "no-speech"
            ? "No speech detected. Try again."
            : "Speech recognition stopped. Try again.";
  return `${explanation} (${error}${detail ? `: ${detail.slice(0, 200)}` : ""})`;
}

function collectResult(
  result: SpeechResult,
  index: number,
  finalized: Set<number>,
  onTranscript: (text: string) => void,
) {
  if (result.isFinal && !finalized.has(index)) {
    finalized.add(index);
    onTranscript(result[0].transcript);
  }
  return result.isFinal ? null : result[0].transcript;
}

function supportsLocalRecognition(current: Recognition, Speech: RecognitionConstructor) {
  return "processLocally" in current && Boolean(Speech.available);
}

/** Lets the composer end dictation when it sends what was heard so far. */
export type DictationHandle = { cancel(): void };

export default function Dictation({
  ref,
  disabled,
  onTranscript,
  onInterim,
  onBusy,
}: {
  ref?: Ref<DictationHandle>;
  disabled: boolean;
  onTranscript: (text: string) => void;
  onInterim: (text: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [state, setState] = useState<
    "idle" | "checking" | "download" | "installing" | "listening" | "stopping"
  >("idle");
  const [message, setMessage] = useState("");
  const interim = useRef("");
  const recognition = useRef<Recognition | null>(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onTranscript, onInterim, onBusy });
  callbacks.current = { onTranscript, onInterim, onBusy };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = recognition.current;
      if (current) {
        current.onresult = current.onerror = current.onend = null;
        current.abort();
      }
    };
  }, []);

  function releaseRecognition() {
    const current = recognition.current;
    recognition.current = null;
    if (current) {
      current.onresult = current.onerror = current.onend = null;
      current.abort();
    }
  }

  // Bumped by cancel, so a start still checking availability does not begin listening.
  const generation = useRef(0);
  useImperativeHandle(ref, () => ({
    // The text was already sent with the interim words: discard the rest, without a transcript.
    cancel() {
      generation.current++;
      releaseRecognition();
      interim.current = "";
      if (!mounted.current) return;
      setState("idle");
      setMessage("");
      callbacks.current.onInterim("");
      callbacks.current.onBusy(false);
    },
  }));

  function finish(text: string) {
    if (!mounted.current) return;
    setState("idle");
    if (interim.current) callbacks.current.onTranscript(interim.current);
    interim.current = "";
    callbacks.current.onInterim("");
    setMessage(text);
    callbacks.current.onBusy(false);
  }

  function startRecognition(current: Recognition, lang: string, availability: Availability) {
    if ("processLocally" in current) current.processLocally = availability === "available";
    current.lang = lang;
    current.continuous = true;
    current.interimResults = true;
    const finalized = new Set<number>();
    current.onresult = ({ results }) => {
      if (!mounted.current || recognition.current !== current) return;
      const pending: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const transcript = collectResult(results[i], i, finalized, callbacks.current.onTranscript);
        if (transcript !== null) pending.push(transcript);
      }
      interim.current = pending.join(" ");
      callbacks.current.onInterim(interim.current);
    };
    current.onerror = ({ error, message: detail }) => {
      if (recognition.current !== current) return;
      releaseRecognition();
      finish(recognitionErrorMessage(error, detail));
    };
    current.onend = () => {
      if (recognition.current !== current) return;
      recognition.current = null;
      finish("");
    };
    recognition.current = current;
    setState("listening");
    setMessage("");
    current.start();
  }

  async function downloadPack(Speech: RecognitionConstructor, options: Options) {
    setState("installing");
    setMessage("Preparing dictation…");
    if (!Speech.install) return false;
    const installed = await Speech.install(options).catch(() => false);
    if (mounted.current && !installed) {
      finish("Could not prepare local dictation. Try again or use browser dictation.");
      setState("download");
    }
    return installed;
  }

  async function localAvailability(
    Speech: RecognitionConstructor,
    options: Options,
    preferLocal: boolean,
    supportsLocal: boolean,
  ): Promise<Availability | null> {
    if (!preferLocal || !supportsLocal) return "unavailable";
    if (!Speech.available) return "unavailable";
    const availability = await Speech.available(options).catch(() => "unavailable" as const);
    if (!mounted.current) return null;
    if ((availability === "downloadable" || availability === "downloading") && Speech.install) {
      return await downloadPack(Speech, options) ? "available" : null;
    }
    return availability;
  }

  async function dictate(preferLocal = true) {
    if (state === "listening") {
      setState("stopping");
      recognition.current?.stop();
      return;
    }
    const browser = window as typeof window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const Speech = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    const lang = navigator.language || "en-US";
    const options: Options = { langs: [lang], processLocally: true };
    try {
      if (!Speech) {
        finish(
          "Speech recognition isn’t supported by this browser. Use your keyboard’s microphone instead.",
        );
        return;
      }
      const current = new Speech();
      const started = generation.current;
      const supportsLocal = supportsLocalRecognition(current, Speech);
      callbacks.current.onBusy(true);
      setState("checking");
      setMessage("");
      const availability = await localAvailability(Speech, options, preferLocal, supportsLocal);
      if (!mounted.current || availability === null || started !== generation.current) return;
      startRecognition(current, lang, availability);
    } catch {
      releaseRecognition();
      finish(
        "Could not start dictation. Check browser permissions or use your keyboard’s microphone.",
      );
    }
  }

  const waiting =
    state === "checking" || state === "installing" || state === "stopping";
  return (
    <div className="dictation">
      <button
        type="button"
        className="dictate"
        disabled={disabled || waiting}
        onClick={() => void dictate()}
        aria-label={
          state === "listening"
            ? "Stop dictation"
            : state === "download"
              ? "Retry dictation"
              : waiting
                ? "Please wait…"
                : "Dictate"
        }
        title={
          state === "listening"
            ? "Stop dictation"
            : state === "download"
              ? "Retry dictation"
              : waiting
                ? "Please wait…"
                : "Dictate"
        }
        aria-pressed={state === "listening"}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {state === "download" && (
        <button
          type="button"
          className="dictation-fallback text-button"
          disabled={disabled}
          onClick={() => void dictate(false)}
        >
          Use browser dictation
        </button>
      )}
      <span className="dictation-status" role="status">
        {message}
      </span>
    </div>
  );
}
