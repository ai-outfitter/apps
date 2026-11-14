# Agent-driven marketing production

A product owner asks an agent for a launch demo. The agent reads the product and
revision evidence, writes the brief and storyboard, generates individual takes,
and assembles a film. Planning displays the saved production at `/videos`, with
private playback and **Download MP4**. No production form is required.

The initial product capability belongs to the existing Outfitter Marketing
product. Planning hosts its first implementation because it already owns product
revision evidence. Creative Team (`apps/creative-team`) is complementary: it owns
personal-brand strategy, a content map and written drafts, including scripts.
The second marketing app mentioned during discovery has not been identified;
this change does not invent an app or install Creative Team in customer orgs.

## Agent procedure

Use the normal scoped `graph_documents`, `graph_query`, and `graph_mutate` tools;
all documents below belong to `planning`. Browser reads use these same documents.

1. Read `Products`, then `VideoSourceEvidence(productId)`. Inspect graph cursor,
   omissions and evidence provenance; follow the cursor before claiming full
   coverage. ProductRevision identity and its graph record revision are distinct.
2. `SaveVideoProduction`: supply a stable UUID, revision zero, and a packet with
   product reference, optional product revision, audience, message, style, channel,
   concept flag and ordered shots. Each shot has a stable UUID, duration, prompt,
   narration and optional source citation. Subsequent saves use the last revision.
   Conflicts require a fresh read; complete packet replacement preserves history.
3. Generate storyboard frames using the agent's image tool, or obtain actual
   screenshots/renders from the evidence bundle. Upload with `ReserveVideoAsset`,
   PUT the exact bytes to its short-lived upload ticket, then `CommitVideoAsset`.
   For authenticated agent runtimes without a direct-upload signer, reserve with
   `transport: "http"` and PUT bytes to the scoped installation URL; this verifies
   and commits the bytes in one request. The default remains direct uploads.
   Reference the ready frame asset and its SHA256 in the next packet revision.
   Use exact UI captures directly in the edit when the interface must be faithful.
4. `PrepareVideoTake` freezes one shot and its settings under a new take UUID.
   This is a spend-free preparation, with a published-rate estimate, not a bill.
   `UpdateVideoTake(state: submitting)` atomically claims the take. Only a response
   with `claimed: true` permits submission. A repeated claim is not permission to
   submit again. Persist this claim as a private JSON file for the executor.
5. Run `scripts/video-executor.mjs submit CLAIM.json NEW_OUTPUT_DIRECTORY [IMAGE]`
   in an authorized agent runtime with Node and `FAL_KEY` in its environment.
   The image must match the pinned hash. The executor saves the exact request and
   provider receipt, and writes the next `UpdateVideoTake` input. Apply it through
   MCP before polling. There is no browser-held key and no credential in graph data.
6. Run `video-executor.mjs collect CLAIM.json OUTPUT_DIRECTORY` until complete.
   Collection never creates another generation. Upload the raw MP4 as kind `take`,
   then mark the take completed with its asset ID. A lost POST response remains
   uncertain until a provider receipt is reconciled; never blindly retry it.
7. Assemble with `video-assemble.mjs EDIT.json NEW_OUTPUT_DIRECTORY`. Its ordered
   `shots` array has `file`, `sha256`, `duration`, and optional `image: true` for
   stills. This baseline edit produces silent 720×1280 H264 at 24 fps, verifies
   every input hash, and fully decodes the result. Narrated/custom edits may be
   made by the same agent using FFmpeg; retain their recipe and source hashes.
8. Upload the finished MP4 as `final`, and the edit/evidence manifest as `manifest`.
   `PublishVideoProduction` writes the packet's graph Document and product
   references. Open `/videos/<production-id>` to review or download it. Distribution
   is a separate action; this workflow never posts to a social account.

Generation and assembly require the authorized agent runtime. This release does
not install a permanent GPU/media worker or keep fal credentials in Planning.
MCP coordinates and records the work; the provided executor performs inference
and FFmpeg work. Preparing a take alone does not mean generation has started.

## Sources, versions and private media

Media belongs to an installation's private `video/productions` storage space,
retained for one year under the existing SDK storage policy. Maximum file size is
25 MiB; use a smaller export for larger originals. Reservation is idempotent for
an identical asset UUID/metadata; mismatched size or SHA256 fails verification.
Use a new asset ID for a different file. Presigned upload tickets are temporary;
playback/download routes are authenticated and stable for the retained object.

Packet revisions and takes remain separate. Replacing one frame creates a new
packet version and leaves previous takes intact; prepare only shots needing new
footage. Older films show their storyboard version when the packet has advanced.
Generic archive imports omit take execution state and asset indexes so an import
cannot recreate a submission claim or pretend to restore missing media bytes.

The spike produced Artera 60s/30s photoreal mission concepts and a Sunny 15s
location-scan preview. The latter contains clearly labeled concept UI; access to
the real app remains necessary for a verified interface demo. Film quality and
mission imagery do not establish product capabilities or flight heritage.

## Related products and overlap

Checked against first-party documentation on 2026-11-13:

| Product | Overlap | Relationship to this capability |
| --- | --- | --- |
| [LTX Studio](https://help.ltx.io/hc/en-us/p/ltx-studio) | Script, storyboard, generation, timeline and sound | A full creative environment; a potential generation/editing integration |
| [Boords Agent](https://boords.com/docs/boords-agent) | Conversation edits boards and generates frame images | Agent-first storyboarding is already offered; chat is not our differentiator |
| [Runway Workflows](https://docs.dev.runwayml.com/workflows/) | Versioned API pipelines for media generation and editing | Potential hosted execution backend |
| [Creative Team](../creative-team/README.md) | Brand positioning, content ideas and scripts | Upstream brief/script source, without duplicating its brand interview |

Our proposed distinction is traceability from product revision evidence to shot
sources and finished edits. Follow the shared [graph provider contract](../../docs/graph-providers.md)
and the platform's [knowledge graph architecture](https://github.com/ai-outfitter/webapp/blob/main/docs/architecture/knowledge-graph.md).

## Rollout and evidence

The operational package needs its new migration and private storage bucket before
imports. Existing installations are not changed by pushing this branch. Import
Artera and Sunny independently through the published documents after normal app
activation; never seed private footage into a public demo build. The package's
`__health` includes storage readiness. Review source commit, package and installed
version separately from local tests and synthetic identity screenshots.

`video-import.mjs` exports `importProduction(manifest, {call, upload, transport})`
for importing retained spike films without generating or paying again. The manifest
contains `id`, `packet`, and `assets` with local `file`, UUID, kind, filename, MIME,
size and SHA256. Supply a scoped MCP document caller returning GraphQL data and an
authenticated uploader. It retains initial storyboard and uploaded-frame revisions.
Do not use it to overwrite a production that has subsequently been edited.
