# Shared creative records, separate apps

Marketing, Presentations and Workshop keep their own pages, storage and execution. Onto holds the shared creative record chain; Creative Team remains upstream for brand and script work. Planning continues to own product/revision evidence and the compatibility video routes.

`packages/creative-workflow` supplies a pure resolver, canonical manifests, hashing, dependency comparison, explicit selections and an Artera compatibility adapter. Graph, video, file-storage and import adapters have separate exports. Importing the resolver never invokes a provider, reads a file, writes the graph or approves work.

## Record chain

Product or revision → CreativeBrief → PromptFragment / Storyboard → GenerationSnapshot → CreativeCandidate → CreativeSelection → downstream work.

- Briefs pin the subject revision and reference existing artifacts. Storyboards contain ordered shot or slide narratives.
- Native prompt fragments have explicit ordered dependencies. Freezing records the resolved text, source revisions and hashes, artifact hashes and exact settings. Missing references and cycles fail with a path.
- Snapshots and candidates are immutable **ontology records**, including when accessed through generic graph writes. Register a new candidate to change its artifact or input snapshot.
- CreativeFeedback is a separate immutable record referring to a candidate revision. Historical feedback imported with a candidate is retained. Adding feedback cannot invalidate a selected artifact's revision.
- Selections are mutable only with a revision check. Their storage identity is derived from the use and slot, so competing creation attempts cannot produce two committed selections for the same slot. There is no newest-candidate fallback.
- `creative_for` links the records to products, revisions, requirements or evidence. Artifact references reuse the SDK's `artifactRef`; the owner, version, hash and retrieval location are references, not additional access grants.

The candidate reader computes native freshness from the current committed prompt dependency tree. The core `drift(previous, current)` also compares input images and settings when preparing another generation. A record without a saved snapshot is unknown. A missing dependency on a known native snapshot is stale with an explanation. Historical Artera snapshots preserve their original resolver and are not silently compared using native resolver semantics.

## MCP and browser contracts

Onto publishes `CreativeRecords`, `StageCreativeRecord` and `FreezeCreativeInputs` through the existing document mechanism. Published writes use addresses such as `CreativeBrief:artera-launch`, `PromptFragment:spacecraft-description` and `GenerationSnapshot:hero-v1`. Returned `bodyView` is an address-oriented presentation, not the bytes to hash; the immutable manifest stays in the graph and the execution adapter reads it directly. Internal app adapters retain exact SDK entity references.

A stage call returns a draft batch. Use the existing submit/review documents; the app cannot approve its own batch. Supplying the same batch and record retries its proposal. Reimporting identical committed content is a no-op. Stale revisions fail rather than overwrite. Shared reads use the authorized default Onto installation. External organizations receive only the existing share schema, not creative-record access.

Use `StageCreativeRecord` with kind `CreativeFeedback` for feedback, and `CreativeSelection` for an explicit per-use selection. Neither operation generates anything.

### Marketing

- Native `/videos` and `/videos/:id` pages show versioned storyboards, takes, receipts, playback and MP4 downloads. `/creative` shows shared records and comparisons.
- Production packets optionally pin shared briefs/storyboards; shots optionally pin a committed generation snapshot. A linked snapshot supplies the exact prompt. Its explicit settings must agree with the supported executor request; unsupported settings fail before a take is prepared. Image inputs must pin the uploaded image hash.
- Existing fal and FFmpeg scripts remain agent-side adapters. They are not a new permanent worker. Preparing a take is not spending money or submitting it.
- Publishing a production stages a reviewed graph Document linked to its product/revision, rather than bypassing graph review.

### Presentations

- `/creative` displays ordered narratives and candidates; `/artifacts` lists private rendered decks, illustrations and source bundles with preview/download links.
- `ReservePresentationArtifact` reserves a digest and size; authenticated PUT uploads verify the bytes. Reads and downloads are installation-scoped.
- `scripts/export-deck.mjs PINNED_MANIFEST.json NEW_DIRECTORY` verifies the selected image hashes, writes Slidev source and copies references. Render using the repository's pinned Slidev toolchain. Register the resulting PDF, illustrations and source ZIP through the existing upload/document flow.
- The manifest names a pinned storyboard plus selections containing `slot`, pinned `candidate`, local `file` and `sha256`. It does not invent a selected asset, install dependencies, call a provider or edit slide layout interactively.

### Workshop

- `/creative` shows design requests, linked mockups and generation history.
- `AcceptCreativeHandoff` pins a committed selection and candidate; it records purpose, known dimensions/materials/interfaces, open questions and acceptance criteria on the native project. Unknowns stay explicit. The handoff changes no CAD and triggers no build.
- `AttachCreativeResult` requires a committed candidate owned by that Workshop project, its exact `ownerRevision`, and a subject pointing back to the handed-off candidate. The result can name a CAD artifact or evidence bundle; subsequent render candidates can reference it and be selected by either consumer.
- Repeating an identical handoff or result attachment does not create another project revision. A concept selection never grants manufacturing approval.

## Artera import

```sh
node --import tsx packages/creative-workflow/scripts/import-artera.mjs \
  /path/to/artera docs/presentations/2026-08-12-investor-advisor-deck \
  /private/path/artera-import.json
```

The source is read-only. The private transport manifest retains raw fragments, paths, resolved current prompts, image hashes, available historical manifests/text, provenance logs, candidate files, feedback and selection records. Files and symlinks must remain within the supplied repository. Surviving renders without logs are retained as unknown; current prompts are never attached to historical images by inference.

The pure `./import` adapter accepts authorized `read`, `stage` and artifact-registration callbacks. `stage` receives the input for the published address-based `StageCreativeRecord` document; `read` receives the exact entity ID and its address. Provide the subject’s canonical ID/revision and its readable address. It derives stable IDs, stages into a caller's existing batch, and refuses to overwrite subsequently authored records. Review snapshots before registering dependent candidates; review candidates before completing selections. The returned deferred lists identify the next import pass. Only documented explicit picks become selections; legacy newest/default choices remain source evidence. No pass invokes generation.

Artera's legacy resolver intentionally visits cyclic references once, matching the original implementation. It retains ordering, triple-newline separators, reference replacement and 16-character hashes. Native resolver `creative-workflow/1` rejects cycles. These are independent versions, not an accidental hash migration.

## Video migration

1. Reconcile pending uploads and submitting/submitted/uncertain takes on Planning. Choose the authorized Marketing installation.
2. Call `BeginVideoTransfer` on the exact production revision. Source database guards seal further production/take/asset writes.
3. Call `ImportVideoTransfer` from Marketing. It reads the source through authorized host dispatch and verifies the bound destination, production identity and metadata hash. IDs, versions and provider receipts are preserved.
4. Copy each existing media file through Marketing's private upload/commit endpoints. These verify the original size and SHA-256; the import reserves identical metadata but does not invent uploaded bytes.
5. Call `FinishVideoTransfer` on Planning. It verifies the destination's current normalized metadata and every ready file's size/hash before recording completion. Metadata changed during transfer fails acceptance.
6. Update new production links only after that receipt. Existing Planning URLs continue serving the retained source, including downloads. The code does not delete source data or perform an automatic live cutover.

Retries do not resubmit provider requests. A seal is deliberately durable; operators must choose the destination correctly and retain both installations during migration. Do not start destination generation until acceptance. No cross-application database copy or generic archive import may manufacture execution receipts.

## Acceptance and rollout

See [verification](verification.md). `scripts/creative-flow.ts` exercises the shared graph, reviewed records, Workshop handoff/return, explicit CAD execution and reuse by both app readers using built app packages and a synthetic organization. It makes no provider calls and is not engineering approval or a production activation claim.

Deployment and organization-by-organization data cutover remain explicit release work. Keep existing Planning links and source media until the live migration receipt is accepted. No social publishing, general workflow builder, provider marketplace, permanent generation worker, quarterly automation, presentation layout editor or automatic manufacturing CAD is introduced.
