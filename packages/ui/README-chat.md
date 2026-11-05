# React conversations

Import the package stylesheet once in the containing Astro layout, then hydrate
only the React conversation that owns live state. React is an optional peer;
the host supplies its React renderer (for example, Astro's React integration).

`ChatComposer` accepts controlled `value` / `onChange`, `onSend({text, files})`,
optional `onStop`, `sending`, `disabled`, `readOnly`, and two React slots on the
bottom row: `actions` next to Send (for example, effort selection or dictation)
and `leading` on the left, which replaces the default Add (+) menu; without it,
the Add menu shows when attachments are on. Labels, icons, and placeholder are
configurable. `displayValue` can include dictation interim text; Enter and Send
submit what is shown, `displayValue` included, even while `readOnly`, so an app
can stop dictation in `onSend` and send what was heard so far. Enter sends; Shift+Enter inserts a newline;
IME composition does not send.

On mobile, an empty composer rests on one row. Focus, text, attachments, or an
error expand it into a text field above its controls. The same textarea stays
mounted through the transition; multiline drafts grow to a bounded height and
then scroll. An empty composer compacts again after focus leaves it.

Resolve `onSend` with `false` or reject to retain the draft. Rejections appear in
an alert. Success clears submitted files and clears text only if it has not been
edited during submission. Regular webapp chat accepts immediately and delegates
stream failures to its existing Retry control; workspace chat waits for the
backend to accept the message. Supply `sending` and `onStop` for interruptible work.
The app owns transport, authorization, upload progress, and server validation.

Attachments are off by default. Opt in with
`attachments={{accept: "image/*,.pdf", maxFiles: 4, maxBytes: 10_000_000}}` only
when the consumer can actually send files. Optional `validate(file)` returns a
rejection message. Selection, paste and drop use the same checks; rejected files
produce visible errors. Images get temporary previews; their object URLs are
revoked when removed or unmounted. Client checks must be repeated server-side.
Webapp chat attaches images and PDFs; workspace chat remains text-only.

`ChatPanel` provides a labelled conversation region with a live transcript log,
optional `header`, transcript `children`, and a `composer` slot. Use
`variant="sidebar"` to place a conversation beside an app workspace. Keep the
panel and composer within one island when they share streaming state. Templates
can adopt this API when their own conversation transport is implemented.

## Full input

Use `react/ChatInput` for the complete input shared by root chat and app sidebars.
It wraps `ChatComposer` with `Dictation` and `ThinkingEffort`; the lower-level
composer remains available for specialized consumers. The same attachment
validation, previews, paste/drop, resizing, send/stop and draft retention apply.

```tsx
<ChatInput
  value={draft} onChange={setDraft}
  attachments={imageAttachments} effortEnabled
  onSend={async ({ text, files, effort }) => {
    // Upload using the host's transport, then submit its turn.
    // Return false or throw to retain the draft.
  }}
/>
```

`imageAttachments`, `Effort`, and shared limits come from
`@ai-outfitter/app-sdk/chat-input`. `effortEnabled` defaults to false;
`dictationEnabled` defaults to true. `active={false}` stops speech capture in a
hidden panel while preserving unsent words. `onEffortChange` informs transports
that need the current effort for retries. The input retains the preference in
`outfitter:thinking-effort`. It never uploads files or selects an inference model.
