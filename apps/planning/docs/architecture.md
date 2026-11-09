# Planning architecture and manual delivery

Planning owns shared organization projects and issues; Forerunner owns private member priorities. Planning supports optional reviewed transcript chat through the app SDK; Forerunner's transcript sidebar ships independently. Manual records require no inference provider or resident.

## Ownership

Apps depend on Outfitter through generic SDK contracts. The platform runtime does not import Planning or Forerunner implementations, schemas or domain contracts. Catalog/build registration identifies packages; authentication, routing and storage do not interpret their records. Installing or upgrading either app requires only its installation migrations and approved package, with no app-specific primary-database migration or platform runtime hook.

Planning owns shared projects and issues, validation, routes and UI under `apps/planning`. Forerunner owns private items, validation, routes and UI under `apps/forerunner`. Each installation has its own database. No app reads the platform database or another app's tables. Any future shared app contracts belong to app packages; the platform cannot depend on those contracts.

## Manual records

Planning projects contain goals, user stories, a draft press release, demo instructions and demo results. Chat projects remain conversation containers and do not duplicate Planning issue authority. Stones, pebbles and sand are categories of one shared issue model; parent/sub-issue relationships are independent of category, acyclic and within one project and installation. Issues support assignment, dates, status, accessible ordering and optimistic revisions. Parent deletion requires handling its children first.

Forerunner starts empty for each member and keeps stable private IDs, categories, parent stones, ordering, notes, due dates and completion. Administrators receive no additional access. Upgrading or installing Planning does not publish private records. There is no automatic sharing or cross-app synchronization. Members manually manage both apps without OAuth grants, resident configuration, source reads, scheduled scans or model calls.

Both modes render the same app shell. Demo mode is synthetic and read-only. Cloudflare is the managed-app target; domain/storage tests also run with SQLite/libSQL. Native Node managed-app hosting remains a separate platform gap.

## Platform dependencies

Planning declares `api.serve`, `organization.members.read`, `threads.use` and `threads.provide`. Its Worker validates assignees against the live verified member snapshot, and stale picker data cannot authorize a removed member. Complete snapshots support up to 500 members and 60 KB encoded IDs; oversized snapshots fail closed.

The platform owns authentication, forwarding, the member directory and catalog publication. Planning owns its catalog presentation and artwork in `app.json` and `catalog/cover.png`.

## Testing and release

Domain/SQLite integration and desktop/mobile/read-only browser scenarios, configuration and setup stay in this package and use public SDK/test-host interfaces. Platform admission, identity, routing and installation checks are tested with the platform. Preserve private Forerunner IDs and relationships; installing Planning does not publish or migrate them into shared records. Production release and installation require approval.

See [Forerunner's roadmap](../../forerunner/docs/roadmap.md) for later evidence work. Planning's transcript intake uses pasted text and app-owned instructions; it does not depend on the Forerunner sidebar or a shared homepage workflow.

## Page-aware assistance

Planning registers the shared app-agent contract (`@ai-outfitter/app-sdk/threads`).
It owns canonical project/issue context, proposal validation, revision checks,
receipts and approved writes in its installation database. Conversation history
is stored by the platform thread service, never in Planning's database (see the
package README, "Conversations and proposals").
The platform supplies generic authenticated inference and metering. Manual
Planning and Forerunner still need no provider or resident; optional Planning
chat requires an approved organization inference provider. Connected sources,
external publication, custom agents and resident execution remain deferred.

## Transcript intake and repository links

An empty Planning installation offers project-intake conversations (context `planning.intake`). Saved project/issue chat also receives a bounded list of canonical project summaries from the same installation. The assistant can explain a transcript match, propose an issue for an explicit existing project or propose a new project. Ambiguous matches require a member choice. The review identifies the destination project; approval writes the selected target atomically, with no external provider reads. Approval of a new project precedes its child issues.

`githubRepository` is an optional `https://github.com/owner/repository` link stored with the project. Manual and agent writes validate it through the same project fields; revisions preserve omitted values. No OAuth grant, repository permission or live GitHub read/write is implied. Different template forks can replace that concrete field and provider integration when needed.
