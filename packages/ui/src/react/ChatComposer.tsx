import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import Icon from "./Icon";
import "../styles/chat.css";

export interface ChatDraft {
  text: string;
  files: File[];
}
export interface AttachmentOptions {
  /** HTML accept syntax; enforced for picker, drop and paste alike. */
  accept?: string;
  maxFiles: number;
  maxBytes: number;
  validate?: (file: File) => string | undefined;
}
export interface ChatComposerProps {
  /** Use the mobile single-line layout at every viewport size. */
  compact?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Resolve false or reject to retain the draft. Resolve otherwise to clear it. */
  // Return false to keep the draft; returning nothing counts as sent.
  onSend: (
    draft: ChatDraft,
  ) => boolean | undefined | Promise<boolean | undefined>;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  readOnly?: boolean;
  /**
   * For live dictation: what the field shows, such as value plus interim
   * words. Enter and Send submit it, even while readOnly.
   */
  displayValue?: string;
  label?: string;
  placeholder?: string;
  maxLength?: number;
  /**
   * The left of the bottom row, in place of the default Add (+) menu, which
   * shows only when attachments are on; null or omitted keeps the default.
   * Drop and paste still attach files.
   */
  leading?: ReactNode;
  /** Controls next to Send, such as effort selection or dictation. */
  actions?: ReactNode;
  actionsClassName?: string;
  sendLabel?: string;
  stopLabel?: string;
  sendIcon?: string | ReactElement;
  stopIcon?: ReactNode;
  attachments?: AttachmentOptions;
  /** Reports pending files so a host can hold drafts across focus changes. */
  onFilesChange?: (files: readonly File[]) => void;
}
function accepts(file: File, accept?: string) {
  if (!accept) return true;
  return accept.split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    if (rule.endsWith("/*"))
      return file.type.toLowerCase().startsWith(rule.slice(0, -1));
    return file.type.toLowerCase() === rule;
  });
}

function attachmentError(file: File, options: AttachmentOptions, count: number) {
  if (!accepts(file, options.accept)) return "This file type is not supported.";
  if (file.size > options.maxBytes) return `File exceeds the ${options.maxBytes} byte limit.`;
  if (count >= options.maxFiles) return `Attach up to ${options.maxFiles} files.`;
  return options.validate?.(file);
}

const MAX_IMAGE_EDGE = 2048;
/**
 * Vision models downscale large images anyway; doing it here keeps phone
 * photos from carrying megabytes through the upload and every later turn.
 */
async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      bitmap.close();
      return file;
    }
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: file.type, quality: 0.85 });
    return blob.size < file.size
      ? new File([blob], file.name, { type: blob.type, lastModified: file.lastModified })
      : file;
  } catch {
    return file; // Not decodable here; the server still checks it.
  }
}
function unchangedDraft(current: string, typed: string, shown: string) {
  return current === typed || current === shown;
}

function canSubmit(locked: boolean, pending: boolean, value: string, attachments: AttachmentOptions | undefined, files: File[]) {
  return !locked && !pending && Boolean(value.trim() || (attachments && files.length));
}

function resizeTextarea(field: HTMLTextAreaElement | null, shown: string, expanded: boolean, mobile: boolean) {
  if (!field || field.value !== shown) return;
  if (!mobile || !expanded) {
    field.style.height = "";
    return;
  }
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
}

function isExpanded(focused: boolean, shown: string, files: File[], errors: string[], compact: boolean) {
  return (!compact && focused) || Boolean(shown || files.length || errors.length);
}

// The server-rendered field is read-only until hydration attaches Enter and
// change handlers; text typed into it before then would be silently dropped.
function fieldReadOnly(readOnly: boolean, hydrated: boolean) {
  return readOnly || !hydrated;
}

function textareaRows(mobile: boolean) {
  return mobile ? 1 : 2;
}

function composerClass(expanded: boolean, compact: boolean) {
  return `composer ui-chat-composer${compact ? " ui-chat-composer--compact" : ""}${expanded ? " ui-chat-composer--expanded" : ""}`;
}

function AttachmentPreview({ file }: { file: File }) {
  const [url, setURL] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const next = URL.createObjectURL(file);
    setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <>
      {url ? <img src={url} alt="" /> : null}
      <span>{file.name}</span>
    </>
  );
}
/** The default left of the bottom row: an Add (+) menu with Attach files. */
function AddMenu({
  attachments,
  disabled,
  onFiles,
}: {
  attachments: AttachmentOptions;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const addMenuId = useId();
  // CSS anchor positioning places the top-layer menu above its button.
  const addAnchor = `--add-${addMenuId.replace(/\W/g, "")}`;
  return (
    <>
      <input
        ref={picker}
        className="ui-chat-file-input"
        type="file"
        accept={attachments.accept}
        multiple={attachments.maxFiles > 1}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="ui-chat-add"
        aria-label="Add to message"
        disabled={disabled}
        popoverTarget={addMenuId}
        style={{ anchorName: addAnchor } as CSSProperties}
      >
        <Icon name="plus" />
      </button>
      <div
        id={addMenuId}
        className="ui-chat-add-menu"
        popover="auto"
        role="menu"
        style={{ positionAnchor: addAnchor } as CSSProperties}
      >
        <button
          type="button"
          role="menuitem"
          popoverTarget={addMenuId}
          popoverTargetAction="hide"
          onClick={() => picker.current?.click()}
        >
          Attach files
        </button>
      </div>
    </>
  );
}

export default function ChatComposer({
  compact = false,
  value,
  onChange,
  onSend,
  onStop,
  disabled = false,
  sending = false,
  readOnly = false,
  displayValue,
  label = "Message",
  placeholder,
  maxLength = 16000,
  leading,
  actions,
  actionsClassName = "composer-bottom",
  sendLabel = "Send message",
  stopLabel = "Stop reply",
  sendIcon = "↑",
  stopIcon = "■",
  attachments,
  onFilesChange,
}: ChatComposerProps) {
  const [files, setFiles] = useState<File[]>([]);
  const filesChanged = useRef(onFilesChange);
  filesChanged.current = onFilesChange;
  useEffect(() => filesChanged.current?.(files), [files]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  const errorId = useId();
  // readOnly stops editing but not sending, so dictated text can be sent mid-dictation.
  const sendLocked = disabled || sending || submitting;
  const locked = sendLocked || readOnly;
  const shown = displayValue ?? value;
  const sendable = canSubmit(sendLocked, false, shown, attachments, files);
  const expanded = isExpanded(focused, shown, files, errors, compact);
  const singleLine = compact || mobile;
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    const breakpoint = window.matchMedia("(max-width: 760px)");
    const sync = () => setMobile(breakpoint.matches);
    sync();
    breakpoint.addEventListener("change", sync);
    return () => breakpoint.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    resizeTextarea(textarea.current, shown, expanded, singleLine);
  }, [shown, expanded, singleLine]);
  useEffect(() => {
    if (!attachments) setFiles([]);
  }, [attachments]);
  const currentFiles = useRef(files);
  currentFiles.current = files;
  async function addFiles(incoming: File[]) {
    if (!attachments || locked) return;
    const next = [...currentFiles.current];
    const rejected: string[] = [];
    // One decoded photo at a time: a 12 MP bitmap alone is about 48 MB.
    for (const original of incoming) {
      const file =
        next.length < attachments.maxFiles ? await shrinkImage(original) : original;
      const error = attachmentError(file, attachments, next.length);
      if (error) rejected.push(`${file.name}: ${error}`);
      else next.push(file);
    }
    setFiles(next);
    setErrors(rejected);
  }
  async function submit() {
    if (!canSubmit(sendLocked, pending.current, shown, attachments, files)) return;
    pending.current = true;
    setSubmitting(true);
    setErrors([]);
    const typed = value;
    const text = shown;
    const sentFiles = attachments ? [...files] : [];
    try {
      const accepted = await onSend({ text: text.trim(), files: sentFiles });
      if (accepted !== false) {
        if (unchangedDraft(latestValue.current, typed, text)) onChange("");
        setFiles((current) =>
          current.filter((file) => !sentFiles.includes(file)),
        );
      }
    } catch (error) {
      setErrors([
        error instanceof Error
          ? error.message
          : "Could not send your message. Please try again.",
      ]);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <form
      className={composerClass(expanded, compact)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (attachments && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (!attachments || !event.dataTransfer.files.length) return;
        event.preventDefault();
        void addFiles(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        if (!attachments || !event.clipboardData.files.length) return;
        event.preventDefault();
        void addFiles(Array.from(event.clipboardData.files));
      }}
    >
      {attachments && files.length > 0 && (
        <ul className="ui-chat-attachments" aria-label="Attachments">
          {files.map((file, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same file can be attached twice.
            <li key={`${file.name}-${file.lastModified}-${index}`}>
              <AttachmentPreview file={file} />
              <button
                type="button"
                disabled={locked}
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setFiles((current) => current.filter((_, i) => i !== index));
                  setFocused(false);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={textarea}
        aria-label={label}
        placeholder={placeholder}
        value={shown}
        readOnly={fieldReadOnly(readOnly, hydrated)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        rows={textareaRows(singleLine)}
        aria-describedby={errors.length ? errorId : undefined}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {errors.length > 0 && (
        <div id={errorId} className="error" role="alert">
          {errors.map((error, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: error messages can repeat.
            <p key={index}>{error}</p>
          ))}
        </div>
      )}
      <div className={actionsClassName}>
        <div className="ui-chat-leading">
          {leading ??
            (attachments ? (
              <AddMenu attachments={attachments} disabled={locked} onFiles={(picked) => void addFiles(picked)} />
            ) : null)}
        </div>
        <div className="ui-chat-actions">{actions}</div>
        {sending && onStop ? (
          <button type="button" className="send" disabled={disabled} aria-label={stopLabel} onClick={onStop}>
            {stopIcon}
          </button>
        ) : (
          <button type="submit" className="send" aria-label={sendLabel} disabled={!sendable}>
            {submitting || sending ? "…" : (sendIcon ?? null)}
          </button>
        )}
      </div>
    </form>
  );
}
