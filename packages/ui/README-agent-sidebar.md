# Agent sidebar

Part of [`@ai-outfitter/ui`](README.md): an agent in a panel beside a page. It owns
the panel shell (toggle wiring, open state, Escape, focus on open and return on
close, the phone full-screen layout with an inert background), the header with
the agent's name and the page's focus, and the transcript and composer.

The host owns everything with authority: transport, server routes, sign-in,
persistence, inference and what an action does. The lower-level sidebar owns no conversation transport. The shared input stores
its thinking-effort preference; the panel may store whether it is open. The UI
package imports no platform source
(`tests/app-package-boundary.test.ts` checks the UI package like an app package). The root
Outfitter chat is the first host; app templates can adopt it in parallel.

## Exports

| Export | What |
| --- | --- |
| `react/AgentSidebar` | Default `AgentSidebar`; named `AgentMessageText` (the default message body) and the contract types |
| `astro/AgentSidebarToggle.astro` | Header button: `controls` (the panel id), `label`, optional `icon` |
| `agent-focus` | `AgentFocus`, `sameFocus(a, b)`, `describeFocus(focus)` |
| `agent-sidebar.css` | Panel and toggle styles; both components import it |

It builds on the package's `ChatPanel`, `ChatComposer` and `Icon`, and needs
its stylesheet, which `AppLayout` includes. React is a peer: a host
needs Astro's React integration and mounts `AgentSidebar` as one island in
`AppLayout`'s `overlays` slot, where it becomes a third column on desktop.

## Host contract

```tsx
<AgentSidebar
  id="workshop-agent"                       // toggles name it in aria-controls
  agent={{ name: "Workshop", icon: "workspace" }}
  focus={{ kind: "workshop-project", id, label, revision, project }} // or null
  scope={{ intro: "Describe a change…", limits: "Nothing changes until you approve it." }}
  conversation={{ id, messages, status, error, notice }}            // null while loading
  onSend={({ text, focus }) => { /* post to the host's own route */ }}
  onStop={…} onRetry={…} onNewConversation={…}
  onOpenChange={(open) => { /* load lazily on first open */ }}
  openStorageKey="…"                        // reopen after full-page navigation
  actions={<a href="…">Open in full chat</a>}
  renderContent={(message, { focus, busy, send }) => <>
    <AgentMessageText message={message} />
    {/* host cards: proposals, tool results */}
  </>}
/>
```

```astro
<AgentSidebarToggle slot="header-actions" controls="workshop-agent" label="Ask Workshop" />
```

- **Messages** are `{ id, role, parts }`, where each part has a `type`. AI SDK
  `UIMessage`s fit as they are. The default body shows `text` parts as plain
  text; `renderContent` replaces it, for Markdown, tool parts or action cards.
- **Status** `submitted` or `streaming` is busy: send becomes Stop, New chat is
  disabled. `error` shows with Retry when `onRetry` is set.
- **Sends** carry the text and the focus it was written for. Return or resolve
  `false` to keep the draft.

## Focus is a claim, not authority

`focus` is what the page shows, for display and as a claim on each send. The
browser can send any focus. A host's route must, for every send and action:

1. resolve the tenant and member from the request (`requestTenant()`,
   `authorize()`), never from the body;
2. re-read the focused item by `kind` and `id` from its own store and check
   the member may use it;
3. refuse a `revision` that is no longer current (409), rather than apply a
   change to newer work;
4. re-check a proposal's target and revision when it is approved. Disabling
   Approve in the card, as `sameFocus` lets a host do, is a convenience only.

## Conversation and focus boundaries

- `conversation.id` is the boundary. Changing it remounts the transcript and
  empties the composer; an unsent draft is dropped, never sent. The host
  chooses the scope: one saved chat (root), one per focused item (a Workshop
  project), or a reset on New chat.
- When the focus changes under a non-empty draft (another item, or the same one
  at a new revision), the panel shows "Now viewing … This draft was written for
  …" and refuses to send until the member chooses **Keep draft for …** or
  **Discard draft**.
- After a send, a later focus change shows a note in the transcript that new
  messages will be about the new focus. The header always shows the current one.
- `renderContent` gets the current `focus`, so a card can compare its target
  with `sameFocus` and refuse to act on a stale one.

## Adapters

| Host | Status | Focus | Transport and actions |
| --- | --- | --- | --- |
| Root Outfitter chat (`src/components/SidebarChat.tsx`) | Implemented | None: Outfitter cannot see the page | `/api/chat`, `/api/chats/:id`, saved per user and organization; Markdown and tool parts; Open in full chat ([sidebar chat](../../docs/sidebar-chat.md)) |
| Workshop | Proposed | `workshop-project`, with the project revision | `POST /api/apps/workshop/agent` already takes `projectId` and `revision` and refuses stale follow-ups. It saves a revision directly; a proposal card needs an approve step that does not exist yet |
| Software Foundry | Proposed | A task, issue or workflow run | Its own route, with approvals following [workflow authority](../../docs/app-workflow-authority.md) |
| Forerunner demo (`catalog/apps/forerunner`) | Implemented, demo-only | `forerunner-stone`: the selected priority | None: per-stone fixture briefing and scripted suggestions in memory; free text is refused and kept ([README](../../catalog/apps/forerunner/README.md)) |

`tests/ui/AgentSidebarFixture.tsx` is a Workshop-shaped host with project
revisions, per-project conversations and proposal cards. It scripts replies in
the browser; it is not the Workshop API.

## Current boundaries

Installed app agents use generic platform inference with dispatch-only SDK
callbacks; Planning owns its conversation, page context and approved document
writes. Installed apps do not use the root `/api/chat` or `/api/chats/:id` store.
Root sidebar chat still has no page context. A Chrome extension or a surface
outside an Outfitter page is not implemented.

## Verification

`npm run test:e2e:ui` runs `tests/ui/agent-sidebar.spec.ts` against the
fixture. The root journey is `tests/e2e/sidebar-chat.spec.ts`. The root
`npm run check` typechecks the package source.

## Standard installed-app adapter

`AppAgentSidebar` binds the sidebar to the SDK page store and the platform's
shared thread service (`@ai-outfitter/app-sdk/threads`): several conversations
per page context (private by default; explicit organization sharing at
creation), child conversations started from a message, and a read-only
workflow-history browser for history types other installed apps publish.
Messages, uploads and replies use `/api/platform/threads` (resolved under the
app's `/o/<org>/<app>` or `/apps/<id>` mount on the main host); the page claim
(focus, opted-in draft) is sent as bounded entry metadata `<pageId>.page`.
The app's `endpoint` serves page context and actions (`GET context?focus=`),
the member's proposals (`GET proposals?thread=`), review decisions
(`PUT proposals/<id>`, `POST proposals/<id>/approve|reject`), deletion
(`DELETE conversations/<id>`) and history reads (`GET history`,
`GET history/entries?ref=`). `SchemaFields` generates editable review controls
from the app schema, with optional relationship display choices. Apps supply
`intro`, `emptyIntro`, `limits` and `demoReply` strings alongside `id`, `pageId`
and `endpoint`. Resolve mode-specific limits in the app; the shared adapter
never describes an application's domain or simulates its demo content. See
[app agent registration](../../docs/app-agents.md). `composerActions` places
context controls above the composer without crowding the header.

## Shared timeline

`@ai-outfitter/ui/react/timeline/Timeline` renders typed thread entries: text,
images, tool calls/results, proposal links (`renderers.proposal` for app review
cards), workflow inputs/outputs, attempts, statuses, artifacts (links only when
`available`; `missing`, `expired` and `incomplete` are stated explicitly;
`renderers.openArtifact` resolves short-lived read URLs) and thread links.
`data` extension parts use `renderers.data[name]` when the host has an app
renderer and otherwise an escaped structured fallback; unknown part types are
shown, never dropped. History timelines (`timestamps="recorded"`) show only
times the source recorded. `TimelinePartView` renders one part for hosts such
as `AgentSidebar.renderContent`.


## Composer capabilities

The sidebar uses shared `ChatInput`. Configure `input={{attachments,
effortEnabled, dictationEnabled, maxLength}}` and handle `onSend({text, files,
effort, focus})` to support files and thinking effort. Dictation is shared by
default. Image-only drafts get the same focus-change protection as text drafts;
explicit discard removes both. Closing the panel stops dictation and preserves
unsent words. `composerActions` remains the slot for app-specific context controls
such as draft inclusion, separate from the shared input's controls.

Operational `AppAgentSidebar` enables shared image uploads and thinking effort.
Its application copy (`intro`, `emptyIntro`, `limits`, `demoReply`) remains required
props. See [app agents](../../docs/app-agents.md) for server ownership and uploads.

Use `transcriptContent` for review cards with local edits. They remain mounted
when a streamed message is replaced by saved history; `renderContent` is for
message bodies whose identity may change when streaming finishes.
