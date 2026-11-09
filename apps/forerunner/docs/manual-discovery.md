# Manual source discovery

> Part of [the knowledge graph](https://github.com/ai-outfitter/webapp/blob/main/docs/architecture/knowledge-graph.md), Outfitter's central architecture for Wikis, ontology, reads and writes.

Forerunner reads an editor's readable Gmail and Google Calendar connections and
saves source-backed Wiki entries as part of each discovery run. Daily discovery is
on by default; **Sources** reruns one account at a time. Settings is one flat page:
the daily run, the connected accounts and the sources still to connect. The
`import` endpoint still accepts a private, bounded source sample from an agent,
though Settings no longer offers an upload.
The manual board remains independent. Demo mode remains synthetic and read-only.

## Discover, save and improve

1. A run reads one or more source accounts or saved samples over a range. A run reads at most 40
   records in all, split evenly across its sources. Direct Gmail reads message
   headers/snippets newest first, excluding spam, trash and promotions. Direct
   Calendar reads primary-calendar events oldest first, through the next 14 days.
   The `range` is `since-last` (the default and the daily run's: since this
   connection's last run, else the last 14 days), `7d`, `30d` or `all` (all mail;
   calendar events from five years back). Each source in the run records its
   window and whether `more` records remain. An `all` run that stopped early
   continues on the next `all` run: before the oldest message read, or after the
   last event read. Once nothing remains, the next `all` run starts again. The
   `sources` endpoint returns each connection's `lastRunAt`.
2. Each run resolves the operating user's current name and email through the
   trusted `identity.current` host API. Neither browser input nor messages choose
   that identity. The request-scoped Wiki adapter resolves the same owner and
   reads every page of active types. Goal, Question, Activity, generic Entity, participates_in, participant,
   interacts_with and customer_of are excluded for now. Discovery retains named
   contacts without creating generic interaction edges or inferring commercial
   relationships from notifications. Relationships
   whose endpoints require an excluded entity type are also omitted. Calendar events
   can introduce people named in the event title or participants and match existing
   entities. Other new entities require a non-calendar source; public speakers
   mentioned only in event descriptions stay as evidence. Recurrence and attendance
   modeling are deferred.
3. Forerunner builds concise ontological Markdown and relationship directions
   from those live records, plus canonical type enums from the same snapshot.
   Type introductions supply definitions; agent guidance and behavioral notes
   are omitted. Relationship direction uses the live structured `ontology.endpoints` contract.
   Only legacy types without that contract use From/To or Domain/Range lines,
   then source/target or subject/predicate/object introductions. Missing, archived
   or unresolved endpoint types cannot produce proposed relationships.
4. Selected sources and relevant existing entities are separate untrusted model
   context. Discovery validates citations, existing identities, canonical types,
   and directed endpoint types before persisting the proposal. Invalid relationships
   are omitted with diagnostics retained on the run. Email-only Person proposals and their
   relationships are also omitted, without guessing a replacement identity;
   other invalid entities fail the run. Named contacts in one-off meetings remain
   eligible, while the meeting itself and incidental public speakers do not.
   Existing edges are matched by their type and endpoints, respecting declared
   symmetry, so reruns do not duplicate edges stored under other IDs. Limits: first 40
   source records, 600 characters per excerpt, first 80 relevant existing nodes.
   Inference uses the configured provider, including the LAN DGX Spark.
5. A Sources **Rerun** uses the `discover` endpoint. After generation,
   the server saves the run as one [Wiki change batch](https://github.com/ai-outfitter/webapp/blob/main/docs/plans/wiki-change-batches.md):
   `batch.open`, then the Wiki's `StageChanges` document (the one chat agents run) with
   each operation's evidence (the cited source records, as `<account>/<record id>`),
   the model's own confidence and its reason, then `SubmitBatch`. Wiki records keep the
   summary or reason as their body; the evidence stays on the batch and in record history. The first run that
   saves anything uses the `first-run` policy, which creates everything and shows a
   summary on the Wiki's Today card and Changes page. Later runs use the `confidence`
   policy (threshold 0.95, version `forerunner-discovery-2026-11`): confident proposals
   commit at once, and the rest wait on the Wiki's **Changes** page until the end of the
   member's day in their browser time zone, when anything not rejected is approved.
   Without a model confidence, a mentioned entity scores 0.8 and an inferred one 0.6,
   so neither auto-commits. Saving again resumes the same batch. A zero-change run is
   marked saved without a batch. The separate `preview` endpoint remains available for
   dry-run evals. Earlier runs saved through `graph.apply` keep their receipts.
6. **Daily discovery** runs discovery every morning (07:00 in the member's time zone)
   on one direct connection; the platform keeps one schedule per installation and
   workflow, and a scheduled run reads only the connection it names. It is on by
   default: when Settings or Sources loads, its script calls
   `POST /api/apps/forerunner/schedule {timezone}`. With no saved
   schedule in a personal installation, that turns the run on for the member's
   readable Gmail connection, else Calendar, in the browser's time zone. Any saved
   schedule, including one the member turned off, is left alone, and organization
   installations start off. Editors only. Settings switches the run off or on and,
   with several accounts, chooses the one it reads (`PUT schedule`). The app saves
   the installation's `forerunner-discovery` schedule naming that connection; at each occurrence the
   platform dispatches the `schedule` phase to `/api/internal/workflow-host/v1`, which
   seals yesterday's due batches (`batch.seal-due`), reads only that connection (the
   schedule phase has no `snapshot`), starts the reserved run and saves a batch as in
   step 5. The run page links to the batch's review page.
7. The result page groups saved entries by type in compact rows. Each row's
   three-dot menu opens evidence, match correction or the saved entry.
   Run feedback is stored privately with the run; an explicit export downloads the
   inputs, output and evaluations for sharing. Diagnostics and validation notes are
   collapsed. Viewing a historical run does not save it.
8. Correct match selects an existing same-type entity from the run's own Wiki.
   It records the corrected identity and updates only relationships created by that
   run through revision-checked `graph.apply`. Other authored nodes and relationships
   are not merged or deleted. Existing duplicate relationships are retained while
   the run's redundant edge is archived. Corrections remain attached to this run;
   they are not model training or a global alias rule.

Forerunner depends on Wiki. The app owns extraction policy and proposals; generic
identity, inference and scoped entity/action access stay in the platform host.
No direct app database or production connector credentials are exposed. Inference
or validation failures preserve the last completed preview. The final save
revalidates Wiki constraints atomically. App recommendations and fine-grained
graph visibility remain deferred.

## Real data locally, without provider credentials

The standard `scripts/dev-local.mjs` server intentionally does not inherit
provider keys or production tokens. It cannot read Gmail merely because the user
has connected Gmail in production. Personal local installations now include
Forerunner alongside Wiki and Planning.

Use an agent's already-authorized Gmail/Calendar tools to read a small, explicitly
bounded sample. Normalize it to the following format, write it outside every
checkout with private file permissions, and post it to
`POST /api/apps/forerunner/discovery/import` (Settings no longer has an upload);
the sample then appears on Sources with its own Rerun. Never commit samples, personal data,
private screenshots, cookies or tokens. Samples contain selected content, not
provider credentials. They are saved snapshots; Preview does not reread Google.

```json
{
  "samples": [{
    "format": "outfitter-forerunner-sample-v1",
    "provider": "gmail",
    "account": "artist@example.test",
    "collectedAt": "2026-10-29T12:00:00Z",
    "collectionMethod": "agent-import",
    "window": "Last 14 days; bounded partial sample",
    "records": [{
      "id": "message-1",
      "title": "Commission brief",
      "text": "Please review the revised sketch.",
      "date": "2026-10-28",
      "url": "https://mail.google.com/",
      "participants": ["Studio client"]
    }]
  }]
}
```

`provider` also accepts `google-calendar`. A sample has at most 25 records; each
excerpt is at most 4,000 characters. Import accepts up to eight samples in a
256 KB request. Prefer provider record IDs and include an optional stable
`accountId` when available. Metadata supplied by an agent is labeled as such;
it does not prove an Outfitter connector read or grant future access. The same
private sample can be reused for later local experiments, separately from
synthetic test fixtures; no eval framework is introduced here.

## Direct connections

Direct reads use the installation-scoped connector gateway with live account
ownership, declared capabilities and revocation checks. Credentials stay with the
platform. Calendar's broker operation is read-only `events.list`, limited to the
primary calendar and a bounded window. No sends, drafts or event writes are
enabled.

GitHub and Slack read the member's own connections the same way, newest first
and in full:

- **GitHub** (`connector.github.activity.read`): issues and pull requests the
  member is involved in (author, assignee, mentioned or commenter), from GitHub
  search with their own GitHub authorization, so GitHub decides which
  repositories are visible. Each record is the description (HTML comments such
  as template guidance removed) and the newest comments. It is cited as
  `owner/repo/pull/N` or `owner/repo/issues/N`, versioned by its last update.
- **Slack** (`connector.slack.channels.selected`, `history.read`,
  `thread.read`): the public channels the member selected on their Slack
  connection, newest first across channels, each thread parent with its replies.
  Channel joins and leaves are skipped. It is cited as `TEAM/CHANNEL/TS`. A
  huddle thread (Slackbot's "A huddle started") reads as its Slack AI huddle
  notes instead: action items first, then attendees and summary, with the
  attendees as participants. Slack's user scopes are `channels:read`,
  `channels:history` and `files:read` (for the notes only), so private channels
  and direct messages are not read, and people appear by Slack user id. A
  connection made before `files:read` says to reconnect Slack in place of the notes.

Both mark the member's own GitHub login or Slack user id as "the operating
user's own account" in a record's participants.

For real local OAuth, use the provider-enabled development path and a registered
Google callback; see `docs/google-connectors.md`. Importing a saved agent sample
avoids that setup for screen inspection. It does not complete Google verification
or validate the direct-provider path.

## Local semantic inference on the DGX Sparks

Use the LAN Spark through the existing OpenAI-compatible inference adapter.
Run this from the feature checkout (older loaders do not recognize the flags):

```sh
node scripts/dev-local.mjs --port 4406 \
  --inference-url http://192.168.1.176:8888/v1 \
  --inference-model GLM-5.3-Flash-EXL3
```

The endpoint is explicit; no inference credentials are inherited from the parent
shell. This development server supplies a placeholder authorization header for
an unauthenticated LAN endpoint. HTTP inference is allowed only with the
local-development marker and is refused in production. Normal provider selection
remains in force; the private local seed must not contain owner inference
providers if you intend to use only the explicitly configured Spark. Model
responses and source text remain in the private local app database. Selecting Run discovery saves new Wiki entries automatically. This validates
saved-sample extraction, not live Google OAuth. Do not use Ollama.

## Hosted preview gap

Forerunner's writable hosted-preview target is disabled because the preview
policy does not approve cross-app, connector and workflow capabilities. Demo
previews stay read-only. Use the private local development server for this flow
until hosted installation approval is available; the preview policy is unchanged.

## Private developer diagnostics

Each run page keeps its sources, validation notes, system prompt, model output
and transcript under Run details. Evaluation export is an explicit download and
includes the retained inputs and output. Feedback is stored privately with the
run. The developer-only `runs` endpoint retains the full diagnostic record and
platform workflow link for inspection. These views keep member/installation
scope and do not grant additional connector access. Older records can only show
the diagnostics retained at the time.

## Wiki ontology primitives available after the main rebase

Wiki now exposes versioned endpoint contracts, symmetric edges, relator slots,
read-only relationship projections, and evidence assertions. See
[the Wiki contracts](../../onto/docs/relators-and-assertions.md).

A friendship can be one symmetric Person-to-Person edge. A marriage can be a
relator node with two distinct spouse participants, projected as one `spouse_of`
relationship when browsing either person. Calendar evidence can support a Person
or a proposed interaction without establishing friendship or marriage.

Forerunner currently generates ordinary nodes and edges with evidence in their
bodies. It does not yet generate relator batches, structured assertion nodes, or
member confirmation receipts. Follow-up integration should read explicit type
contracts instead of relying on description-derived endpoint hints, treat
projections as read-only context, and use Wiki assertion confirmation for claims
that a member explicitly reviews. A graph save is not assertion confirmation.

See [measurable goal and control pilots](../../onto/docs/relator-control-pilots.md) for edge/relator selection, evidence rules, and migration costs.

## Local control pilot seeds

The shared Wiki types include Friendship, ControlCommitment and
ResponseObligation, with complete typed participant slots and a read-only
`friends_with` projection. ControlDefinition and SourceIssueEpisode support
those pilots. Flat discovery excludes relator/assertion types and derived edges
until it can generate complete structured batches.

`node --import tsx apps/forerunner/scripts/seed-control-pilots.ts` accepts
`--data-dir`, `--personal-owner` (an existing Person ID), `--organization-owner`
(an existing Person ID in Outfitter's Wiki), and `--friend-name`. It adds only
missing pilot records to `personal.local.json` and `wiki-snapshots/outfitter.json`,
backs up both originals, retains their separate scopes, and does not contact a
provider or modify live production data. The friend name is explicitly supplied
by the user; matching people are reused, ambiguous matches are refused.

Start the same checkout with `node scripts/dev-local.mjs --port 4406 --no-build`.
Fresh personal and organization installations then load their separate seed
graphs. Existing persistent installations retain authored state and do not
reseed on restart: add the complete missing pilot batch through scoped
`graph.apply` instead of resetting their databases.
Use the local receipt's personal Wiki URL, since installation IDs are scoped.
Open the ControlDefinition and follow its commitment, goal and subject links.
The organization includes a labelled synthetic issue/obligation to inspect the
eight-hour deadline. Controls stay proposed: there is no accepted commitment,
PostHog connection, scheduler, compliance result or notification. Private people
and organization snapshots remain outside Git; the generator and synthetic
integration tests are the reproducible PR artifacts.

Control definitions include SQL measurement, deadline, decision and (where
applicable) aggregation expressions in their declared properties. The Wiki
shows these fields on the record page. These expressions have fixture tests,
but no live source binding or scheduled evaluator. Use the explicit
`--refresh-measurements` option to update measurement fields on already-seeded
pilot records; ordinary seeding remains add-only. Persistent Wiki instances
require the corresponding revision-checked update, not a database reset.

### Structured control pilot definitions

ControlDefinition now declares a JSON body schema. The pilot bodies in
`seeds/control-measurements-v1.json` are the canonical measurement definitions:
typed inputs, population grain, parameter values, window and timezone, ordered
operator programs, evidence rules and explicit graph paths. The operator compiler
produces the optional SQL display properties for seed inspection and fixture
tests; those properties are generated previews, not the authoritative definition.
Regenerate them after editing a body. SemLang/Malloy export is still not implemented.

The Wiki shows live resolution of schema-declared graph requirements above the
formula preview, including missing types, missing or archived connections and
insufficient distinct participants. Missing graph requirements remain saveable as
drafts. Invalid JSON body shapes are rejected by the shared ontology validator.
A separate source-binding list shows unbound executable relations even when the
graph itself is complete: a Product node is not a working provider connection.

Use `--refresh-structured-controls` with the seed command to explicitly upgrade
these two known pilot bodies and their type schema. The command backs up the
private snapshots; it does not rewrite arbitrary authored controls. Existing
persistent installations need the equivalent schema/body update in one
`graph.apply` batch so old Markdown bodies are never left under a new JSON schema.

Flat discovery excludes types with a body JSON Schema until its proposal format can emit and validate those structured bodies. This prevents a plain Markdown proposal from becoming an invalid control record.


### Sources and activity

The operational home is Today (`/`): the member's board and the changes a run
left waiting for review, as one timeline. Settings (`/settings`) is one flat page:
the daily run (on/off, the account it reads, next run and last outcome), the
connected accounts with their last run, and a Connect more sources list (Google
while Gmail or Calendar is missing, GitHub and Slack until each is connected,
and iMessage and Apple Health coming soon). It has no rerun controls of its own.
Sources (`/sources`) lists each connected account with a rerun of that one
source, and Knowledge graph (`/graph`) indexes every record saved by a run
(`GET /api/apps/forerunner/discovery/entities`). No discovery starts from
connecting or importing alone. The manual priority board remains at `/board`;
its home-card links open that page. Links and API calls are relative to the
app's mount (`src/root-href.ts`, `src/scripts/mount.ts`), so the same pages
serve the app host, `/o/<org>/forerunner/` and a personal `/apps/<id>/`.

History (`/history`) reads the same user-and-installation-scoped records as discovery and
shows runs, sample imports, and timestamped accepted saves. Recent days are open;
older weeks and months collapse. It currently shows the most recent 200 retained
records and indicates when older history is omitted. Historical saves without a
recorded save time do not receive an invented event. Connection events are not
inferred from samples. A run links to its own page with its exact prompt, output,
review and expandable transcript; failed runs show their retained error. Developer diagnostics retain
separate access checks. New discovery runs save through graph.apply before opening their results. Historical
unsaved proposals are inspectable; only current-version proposals offer a manual save.

The Outfitter `/connect` consent screen also supports signed-in users. Default
email signups land there unless they supplied a destination. Existing Google
consent handles the actual grants; its same-origin return-path allowlist includes
installed app Settings and Sources pages. Local screenshots and sample content remain private.
