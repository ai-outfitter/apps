# Wiki passage indexing acceptance eval

Issue #268 covers discovery of Wiki passages before they have semantic links and routing of evidenced suggestions to Onto member review. This eval uses two disposable synthetic organization installations. Each organization has its own Wiki and Onto worker, installation database and declared storage. The organizations deliberately share a Wiki page slug. Their source material and graph records differ.

## Operator reference

Use the organization's slug for `scope` and the Onto app slug for `app`. For
MCP, set `variables.wiki` to `{"app":"wiki-map"}`. The Wiki reference inherits
the call's scope. For direct GraphQL, pass
`{"wiki":{"installationId":"<wiki-installation-id>"}}` in the variables. The
Wiki and Onto installations must belong to the same organization. A connected
agent acts with the member's access to both apps.

Discover the documents and their schemas through MCP.

```json
{"name":"graph_documents","arguments":{"scope":"artera","search":"WikiPassage","schema":true}}
```

The [published GraphQL documents](../graph/documents.json) also define the
variables and selected output for each operation.

| Document | MCP tool | Variables | Expected GraphQL data |
| --- | --- | --- | --- |
| `WikiPassageSearch` | `graph_query` | `wiki`, `query` (1–300 characters after trimming), optional `limit` (1–50, default 20), optional `after` | `wikiPassageSearch.passages` contains excerpt text, a source key and revision pin, page slug and revision, document revision when present, attachment filename and SHA-256 when present, and a content hash. The locator includes a Wiki section, one-based PDF page, or transcript cue times in milliseconds, plus character offsets. |
| `WikiPassageStatus` | `graph_query` | `wiki`, optional `limit` (1–50 per held-item list, default 20) | `wikiPassageProgress` reports durable counts, sweep state and last error. `wikiPassageHeldItems` lists current extraction issues and held suggestions with their reasons and source pins. Before the first run, expect zero counters, null `updatedAt`, and empty held lists. |
| `EnableWikiPassageIndex` | `graph_mutate` | `wiki` | `enableWikiPassageIndex` returns a schedule ID, workflow ID `wiki-passage-index`, `enabled: true`, six-hour cron `0 */6 * * *`, timezone `UTC`, and the next run time in Unix milliseconds. An organization editor with Onto write access and Wiki read access must explicitly request it. The receipt records schedule creation or update. Indexing begins on a scheduled occurrence. |

`includeIdentifiers` preserves passage IDs and revision fields in MCP output.

```json
{"name":"graph_query","arguments":{"scope":"artera","app":"onto","document":"WikiPassageSearch","includeIdentifiers":true,"variables":{"wiki":{"installationId":"YOUR_WIKI_INSTALLATION_ID"},"query":"hydroponics","limit":10}}}
```

Repeat the search with `after` set to `wikiPassageSearch.next` until it is null.
Source revisions are checked against the Wiki on each read, so a page of hits can
be empty while a continuation cursor is still available. If GraphQL reports
`extensions.truncated`, retry with the same `after` and a smaller `limit`.
Progress counters reflect the last stored indexing state. Held items reflect
current Wiki revisions.
Page text comes from the published document revision. Attachment citations pin
the verified file bytes and remain stable when the document is edited or republished.
Every anchor must occur in the quoted span. A member approves a connected
proposal together, and approval checks that the anchors and operations still
resolve against the current graph.

Each scheduled occurrence can extract up to 60 sources and send up to 192
passages to inference, subject to its runtime limits. Inference requests share
graph context across up to four passages and return a separate answer for each.
Work on stale pins is
deferred as soon as verification detects it. The inventory sweep later reconciles
those sources. Progress tracks the work still queued.

```json
{"name":"graph_query","arguments":{"scope":"artera","app":"onto","document":"WikiPassageStatus","includeIdentifiers":true,"variables":{"wiki":{"installationId":"YOUR_WIKI_INSTALLATION_ID"},"limit":10}}}
```

The two queries are read-only. The enable mutation saves a recurring schedule.
This example uses the disposable organization from the eval.

```json
{"name":"graph_mutate","arguments":{"scope":"eval-alpha","app":"onto","document":"EnableWikiPassageIndex","variables":{"wiki":{"installationId":"YOUR_WIKI_INSTALLATION_ID"}}}}
```

Personal installations and callers using another organization's share cannot use
these documents. A member without access to the named Wiki cannot read the index.

## Run

Run the following command from the repository root with Node 24 and workspace dependencies installed.

```sh
node apps/onto/scripts/eval-wiki-passages.mjs /path/to/local-evidence
```

The runner builds both operational packages, hashes them, then runs the eval using the existing app-test worker harness. Each invocation creates a fresh evidence directory under the supplied path, or under the system temporary directory when no path is supplied. `run.json` reports the package hashes, commands and exit statuses. `scenarios.jsonl` reports expected and observed outcomes with source revisions, locators, progress and batch states. `test.tap` records the complete test result. A failed scenario stops the dependent sequence. Later scenarios absent from the JSONL did not run.

The eval builds both apps and runs separately from Onto's usual single-app integration command. The following command reuses previously built operational packages.

```sh
WIKI_PASSAGE_EVIDENCE=/tmp/wiki-passage-scenarios.jsonl \
  node --import tsx --test --test-reporter=tap apps/onto/tests/wiki-passage-index.eval.test.ts
```

## Expected results

| Scenario | What the eval checks |
| --- | --- |
| Source fixture | Wiki issues an upload ticket, verifies the PDF and WebVTT hashes, and serves identical bytes to a member. |
| Flat personal scope | A personal installation owner cannot configure or search organization passages. The app rejects both calls before reaching the host. |
| Schedule authorization | A member cannot enable indexing. Alpha cannot configure Beta's Wiki. A trusted owner can save the registered workflow. A dispatch without trusted host props fails. An occurrence forwarded with a member role is declined. |
| Published documents | The generated MCP catalog documents run through `graph.graphql` and `graph.mutate`. A member with Wiki access reads paginated search hits, progress and held reasons, including through a forwarded OAuth client identity. Members and delegated writers cannot enable indexing. Personal, external-organization and unauthorized Wiki callers are refused. Each dispatcher rejects the other operation kind, and read-only calls cannot enable the schedule. |
| Retry and progress | One simulated inventory outage returns HTTP 503 without advancing the sweep. A subsequent reserved occurrence succeeds, clears the error and reports durable and collected progress. |
| Discovery and citations | Before any graph relationship exists, a member finds source text case-insensitively, including PDF page 2 and the WebVTT cue at 133500–139750 ms. The locator and passage text match, and the source includes the exact document revision and attachment hash. |
| Organization isolation | Each organization's own indexed text stays discoverable. A foreign installation ID is denied before Wiki dispatch. Beta cannot read Alpha's review batch. Beta's empty inference creates zero batches. |
| Anchor routing | The valid single-anchor update and one two-operation batch with three named anchors reach member review. The quote covers every anchor. Missing, ambiguous, foreign and unquoted anchors and fabricated quotes stay unresolved with a reason. |
| Review and replay | The packaged review worker saves advisory results while member approval still gates graph changes even with steward approval enabled. The home-card queue shows passage batches only to readers with Wiki access. Replaying an occurrence and running a new clean sweep preserve passage IDs and avoid duplicate batches. |
| Member approval and history | An anchor that became ambiguous after routing blocks approval. An editor approves both valid links in one decision, and the committed history records the locator, source version, hash and member approval. |
| Portable archive authority | Backup exports retain the four passage runtime tables. The preview filters them, and a fresh installation receives zero runtime rows from the actual import. An archive attempting to amend a local passage review is refused before import. |
| Revised and archived sources | A saved draft stays out of the index. Publication immediately invalidates the old page pin and the next sweep supersedes its undecided batch. The unchanged attachment pins and pending review survive publication. Archiving the page hides its text and attachments immediately and the next sweep clears indexed passages. Wiki keeps historical document revisions. |
| Backlog beyond the inventory cursor | With more than 400 sources and stale work ahead of an active passage, one occurrence defers the stale inference and routing entries and processes the active passage before inventory reaches the edited source. |

## Observed results

The synthetic corpus yields six passages from three sources, including a PDF excerpt on page 2 and a WebVTT cue at 133500–139750 ms. Two batches reach member review and six suggestions stay unresolved. The replay preserves IDs and member approval commits the two PDF-backed links. The portable import adds zero passage runtime rows and refuses an attempted amendment of an existing passage review with HTTP 409.

The first run exposed a PDF cleanup error after successful extraction. An independent Poppler read confirmed the fixture bytes and page order. The packaged Wiki parser passed the same locator assertions after the product fixed the cleanup.

Repository tooling passed 42 tests and actionlint. The focused Wiki and Onto integration regression run passed 31 tests, including the synthetic personal and organization layouts, upload receipts, review and archive authority.

## Execution boundary

The Miniflare processes run the built operational Wiki and Onto Workers. Their normal routes handle document revisions, upload verification, inventory, extraction, search, anchor resolution, review staging, review execution, and portable archive handling. Runtime database writes are made by the Workers. The final archive assertion reads the destination database to check for unauthorized writes.

The fixture supplies the host RPC responses for schedule storage, occurrence reservation, cross-app transport, and inference. Its cross-app adapter checks the organization and requested installation, then forwards the real Wiki action with the scoped member and Onto's app actor. The fixture writes only the uploaded bytes at the key provided by Wiki's signed upload ticket, since app-test has no platform signed PUT endpoint. Deterministic inference supplies raw suggestions or a steward answer. The Workers decide their effects and persist the results.

This exercises the app-level installed-worker paths. Hosted cron dispatch, live membership revocation and signed PUT delivery are outside this harness. Inference output is controlled, so results measure routing and validation of those outputs. The PDF contains embedded text, and the transcript is WebVTT. The queue test seeds a larger inventory and stale work directly in the disposable databases. OCR, SubRip, long extraction backoff and production corpus throughput remain outside the fixture. No live Artera data is used.
