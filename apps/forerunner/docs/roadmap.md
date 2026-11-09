# Forerunner roadmap and delivery tracking

Status: manual delivery. Connected sources, proposals/publication, automatic rankings and resident execution remain deferred; none of this roadmap enables provider access or agents.

## One shared scan workflow

Agreed design; implementation remains deferred. The homepage's connected-source scan and Forerunner's scan are the same workflow, with two entry points. Extend the existing webapp `catalog/workflows/forerunner-setup` workflow and reuse the Gmail/Calendar reads already exercised by homepage chat. Extract the legacy Google-specific chat orchestration into shared workflow/package contracts as needed; Forerunner must not import platform source or duplicate the scan pipeline.

The shared workflow discovers supported read capabilities from the member's live authorized connections and selected resources. Connector adapters supply typed tools and records for mail, calendars, conversations and repository work; adding a supported provider extends those adapters/registrations rather than creating another scan. Preserve source identity, citations, observation times and coverage. Unsupported capabilities and unavailable, disconnected, revoked or partially read sources are reported explicitly. A connected account alone does not authorize an app or background run to read it.

Homepage onboarding presents the scan's findings and task proposals in chat. Forerunner consumes the same workflow's findings to maintain private evidence, proposed work and rankings in its installation database. Consumer presentation and persistence stay with their owners; shared scan logic and contracts belong to the workflow package. Outfitter exposes generic invocation, authenticated connector operations and live grants, without importing app schemas or owning prioritization logic.

On-demand scanning is independently deliverable through the existing server/model path. Morning scheduling and continuous events trigger that same workflow when enabled. Resident execution is optional and cannot gate the shared scan; resident retention/revocation requirements apply only when evidence is actually sent to a resident. Shared Planning or external writes still require approval of the exact target and content.

The scan writes its findings to the person's Wiki as one bounded discovery run per scan: a [Wiki change batch](https://github.com/ai-outfitter/webapp/blob/main/docs/plans/wiki-change-batches.md) with a frozen scope, evidence per proposal and the 0.95 auto-accept policy ([discovery runs](https://github.com/ai-outfitter/webapp/blob/main/docs/plans/wiki-discovery-runs.md)). Goals found this way feed [whole-life goals](https://github.com/ai-outfitter/webapp/blob/main/docs/plans/whole-life-goals.md).

Acceptance must run both entry points through the shared implementation with the same member, authorized sources and deterministic provider responses. Verify consistent findings/provenance, addition of another connector without a parallel scan, ordinary-member isolation, revocation, and partial-source failure. Live provider acceptance remains separate from fixtures.

## Personal and organization Forerunner

Proposed; only the personal shape is built. Forerunner runs differently for a person
and for an organization.

- **Personal.** Forerunner reads the member's own Gmail and Calendar into their
  personal Wiki. Signing up with Google connects both, and daily discovery is on by
  default for Gmail, else Calendar.
- **Organization.** An org Forerunner would read the organization's public Slack
  channels, and later other organization sources, into the organization Wiki, and
  later suggest useful things from that graph. It would not start reading a
  member's mailbox on its own, so the default daily run applies to personal
  installations only. Personal Slack discovery reads a member's own selected
  channels; an organization-wide Slack source is not built.

## Deferred connected-agent phase

Connector packages own typed provider operations, OAuth wire formats, paging and verified events. The platform should own generic encrypted credentials, member consent/resource grants, durable intake, authenticated execution and scheduled dispatch. Apps must own source selection meaning, project/repository mappings, evidence/provenance/coverage, refresh state, prompts, rankings, proposals and publication orchestration. Any missing generic capability ships separately with arbitrary-app tests; it must not add app-specific branches or tables to the platform.

The proposed automated release runs the shared scan against supported, authorized sources, initially approved GitHub repositories and selected personal calendars, at 08:00 in the member's IANA timezone, plus Refresh now. Gmail and Slack extend that same scan as their capability bindings ship. Personal evidence stays private. Shared Planning changes and GitHub writes require approval of the exact target, content and revision, with retry-safe receipts and reconciliation of uncertain writes. Source text is untrusted input, not authority. Webhooks durably persist and enqueue work; inference runs outside ingress. Failed or partial refreshes preserve prior rankings and expose coverage/freshness. Revocation stops reads and invalidates dependent private evidence/proposals.

Resident execution is a stretch goal. [Channels #82](https://github.com/ai-outfitter/channels/issues/82) concerns scoped task/session retention and revocation if private evidence is sent to residents; it does not block manual app delivery. No new resident transport, readiness configuration or scheduling integration ships in this PR.

CRM ingestion is deferred. Future personal CRM records require explicit member ownership; selected findings enter team CRM only through exact-content approval. Planning and CRM retain their own records, IDs and authorization. Gmail, Slack, continuous refresh, Linear integration and milestones remain outside this delivery.

## Tracking and verification

Parent: [#319](https://github.com/ai-outfitter/webapp/issues/319). Initial delivery covers [A: architecture](https://github.com/ai-outfitter/webapp/issues/336), [B: projects](https://github.com/ai-outfitter/webapp/issues/337), [C: issues](https://github.com/ai-outfitter/webapp/issues/338), and the manual portion of [K: rollout acceptance](https://github.com/ai-outfitter/webapp/issues/346).

Deferred stretch work: [D: scoped evidence intake](https://github.com/ai-outfitter/webapp/issues/339), [E: Calendar](https://github.com/ai-outfitter/webapp/issues/340), [F: GitHub](https://github.com/ai-outfitter/webapp/issues/341), [G: residents](https://github.com/ai-outfitter/webapp/issues/342), [H: private proposals](https://github.com/ai-outfitter/webapp/issues/343), [I: morning rankings](https://github.com/ai-outfitter/webapp/issues/344), and [J: GitHub publication](https://github.com/ai-outfitter/webapp/issues/345). Later follow-ups remain [Gmail #347](https://github.com/ai-outfitter/webapp/issues/347), [Slack #348](https://github.com/ai-outfitter/webapp/issues/348), [continuous refresh #349](https://github.com/ai-outfitter/webapp/issues/349), and [CRM #350](https://github.com/ai-outfitter/webapp/issues/350).

Initial acceptance covers installation-local SQLite/libSQL and Cloudflare persistence, member/installation isolation, CRUD, independent nesting, assignment, atomic ordering, completion, stale revisions, preserved private IDs, desktop/mobile journeys and read-only demos. Tests guard both app-to-platform and platform-to-app implementation dependencies. Existing unrelated legacy platform integrations are explicitly bounded by the guard and remain separate migration work. Preview verification is separate from provider acceptance; no live provider or production activation is claimed.

Generic capability implementation and its policy tests belong to the [platform contracts](https://github.com/ai-outfitter/webapp/blob/main/docs/app-runtime-capabilities.md). Planning owns its [shared project/issue architecture](../../planning/docs/architecture.md). Forerunner owns private boards, fixture/domain/browser tests, catalog metadata and `catalog/cover.svg`.
