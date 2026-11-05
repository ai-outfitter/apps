# @ai-outfitter/ui

Private `0.1.0` npm workspace package for the Outfitter webapp and its app
templates. Consumers compile source directly; no registry publication or
runtime asset service is required.

```astro
---
import AppLayout from "@ai-outfitter/ui/astro/AppLayout.astro";
import Navigation from "@ai-outfitter/ui/astro/Navigation.astro";
---
<AppLayout title="Example" desktopOpen scrollContent>
  <Navigation slot="navigation" links={[{ label: "Overview", href: "/" }]} />
  <section class="ui-content"><h1>Overview</h1></section>
</AppLayout>
```

`AppLayout` includes the package stylesheet and shared drawer behavior. Its
`navigation`, `header-actions`, `overlays` and default slots carry app content.
The package also exports `Sidebar`, `NavBar`, `TopNav`, `Navigation`, `Section`,
`SettingsRow`, `Table`, `Button` and `Icon` under `astro/<name>.astro`.

Import `@ai-outfitter/ui/styles.css` when using standalone primitives without
`AppLayout`. It contains tokens, base defaults, layout and component styles in
the `outfitter` CSS cascade layer. `tokens.css` is separately available. The stylesheet bundles DM Sans and
Instrument Serif from Fontsource; template CSP allows fonts from the same origin.
`chat.css` includes conversation, composer, attachment and panel styles. App
styles own app-specific content; the package owns common appearance and shell
behavior. Every app compiles its own copy of these assets.

`scripts/workflow-card` renders the shared workflow card from a view model
(`renderWorkflowCard`), with `workflow.css`; the webapp's
`src/lib/workflow-drafts.ts` projects definitions into that model.

React entrypoints are `react/ChatComposer`, `react/ChatPanel` and `react/Icon`.
React is an optional peer: Astro-only consumers do not hydrate it. Mount a single
React island for a conversation that shares live state; follow the app's Astro
navigation and authentication persistence rules. See [Chat components](README-chat.md)
for callbacks, file constraints and draft behavior. `react/AgentSidebar`,
`astro/AgentSidebarToggle.astro` and `agent-focus` put an agent in a panel beside
a page; see [Agent sidebar](README-agent-sidebar.md) for the host contract. Attachments are opt-in and
require the consumer's transport; this package has no upload backend.

`live` keeps page data current: `livePoll(signal, refresh, options)` refreshes
on an interval while the page is visible, refreshes at once when it becomes
visible or the device is back online, doubles its wait after failures and stops
when `until()` is true or the signal aborts. `onRefresh(signal, refresh)`
registers what a pull-down does. `AppLayout`'s shell adds pull down to refresh
in installed apps (standalone display), which have no browser reload: every
pull runs the registered handlers, or reloads a page that has none, with no
cooldown.

The package contains no account API calls or tenant authorization. The webapp's
account adapter and template document adapter supply their own data and links.
The shared shell has one sidebar per page and delegates drawer behavior from the
document; it does not install a competing router.

Run `npm ci` at the repository root to link the workspace. Use
`npm run test:e2e:ui` for isolated component browser checks, plus the root and
template checks/builds for integration. See [UI architecture](../../docs/ui-components.md)
for ownership and acceptance boundaries, and [DESIGN.md](../../DESIGN.md)
for visual guidelines and [theme guide](../../docs/ui-components.md#changing-the-theme-across-all-apps)
for changes across all consumers. `private: true` intentionally prevents
publication; a future release needs its own packaging and release decision.

`Button.astro` renders a native button, or an anchor when `href` is supplied.
Use `variant="secondary"` for quieter actions; primary is the default. Slot
content provides the label. Native attributes (including `disabled`, `type`,
`aria-*` and `data-*`) pass through. Buttons default to `type="button"`; specify
`type="submit"` for form submission. Links retain native navigation semantics.

```astro
---
import Button from "@ai-outfitter/ui/astro/Button.astro";
---
<Button href="/templates/hr" variant="secondary">View template</Button>
<Button type="submit" disabled={saving}>Save</Button>
```

`./astro/ManagedAppLayout.astro` is the full-document shell for installed apps: document metadata, shared frame/navigation, organization link, intro and notice region. App packages import this public entrypoint; `catalog/apps/AppLayout.astro` only forwards older consumers during migration.

### Developer run diagnostics

`@ai-outfitter/ui/astro/RunDiagnostics.astro` renders a native modal with private
run history, an expanded system prompt and model output, expandable model input,
and a collapsed Run details section for ontology, schema, proposal, validation
and platform workflow records. Pass a same-origin `endpoint` relative
to the current page directory and an optional `title`. The endpoint returns
`{ runs: [{ id, startedAt, status, legacy }] }`; `?id=...` returns `{ run, workflow }`.
Apps own the records and must gate both rendering and reads with trusted platform
standing (`appDiagnosticsEnabled(request)`), then enforce their normal owner and
member scope. The platform enables this standing only for its local-development
server, never from a query parameter or forwarded browser header. Older records
can supply a note explaining which diagnostics were not retained.
