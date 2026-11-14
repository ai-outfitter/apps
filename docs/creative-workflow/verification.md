# Verification evidence

Verified locally on 2026-11-14. These checks use built application packages and synthetic installation identities; they do not claim deployed organization activation, a live production migration, or engineering approval.

## Compatibility and graph behavior

- Compared all **16** current Artera deck prompts against the original repository's `resolvedText()` and `treeHash()`: exact text and legacy hash equality, including the legacy cycle behavior.
- The private importer discovered **18** surviving renders. All 18 lack available historical provenance in this checkout and remain unknown; no current prompt was attached to them.
- Shared-core tests cover native DAG resolution, missing dependencies, cycles, changed layers, model/image input identity, explicit selection, legacy bytes/hashes and changed-layer reporting, repeatable imports, frozen Marketing execution settings, graph review and verified transfer receipts.
- Onto integration verifies stage → submit → member review, address-oriented MCP documents, immutable snapshots, stale revision rejection, fragment-driven candidate drift, immutable feedback, unchanged selections, and refusal of unauthenticated/foreign reads. Generic graph writes cannot bypass snapshot immutability.
- Workshop verifies repeated handoffs/result attachment, exact project revision binding, foreign-graph refusal, and unchanged CAD during handoff.

## Built applications and browser checks

- Onto: 111 unit and 115 integration tests passed.
- Planning: 128 unit and 115 integration tests passed, including the retained video compatibility routes.
- Workshop: 35 unit tests passed, including the CAD kernel checks and handoff test.
- Marketing: four private-media integration checks passed; Presentations: private-media/download integration passed. Their published GraphQL documents validate against their schemas.
- Both new apps passed mobile (390 px) and desktop (1440 px) browser review tests. Screenshots were inspected; no horizontal overflow was found.
- Root tooling tests (39) and actionlint passed. Type checks passed for the shared package and affected apps.

## Existing film bytes

The real private Artera and Sunny files were seeded into the built Marketing test installation. Download responses matched the original bytes exactly and refused unauthenticated requests. Independent FFprobe inspection confirmed H.264/AAC, 720×1280, with durations 60.021333 and 15.021333 seconds.

| Film | SHA-256 |
| --- | --- |
| Artera 60 s | `7a39ac10b3ca4e7a94f1a047463abdbd22e23c3ee26e7f899ae081b85f861054` |
| Sunny 15 s | `7eced1ec994680776a3454d405bc1709fc1d6717911e6bdd9cf770662d857684` |

The transfer test separately verifies preserved IDs, versions and provider receipts; a sealed source refuses writes; incomplete media, a different destination or changed destination metadata prevent acceptance. Neither test spends provider credit or cuts over the live installations.

## Artera cross-app example

`node --import tsx scripts/creative-flow.ts` runs built Onto, Marketing, Presentations and Workshop packages with authorized fixture host dispatch. It creates a shared spacecraft description, brief, prompt, storyboard and snapshot; registers a concept candidate; records a selection; hands it to Workshop twice; explicitly runs the CAD kernel; returns a CAD candidate and preview; and selects the same returned preview for a presentation and marketing use. Both consuming app readers return the same graph records. Provider calls: zero.

The CAD is a deliberately simple concept envelope. It is neither a spacecraft design nor manufacturing approval. Set `CREATIVE_EVIDENCE_DIRECTORY` to retain its STEP, mesh and SVG preview outside the repository. The local evidence directory is `/home/ncrmro/repos/ai-outfitter/.local-data/creative-workflow/acceptance-2026-11-14/`.

## Slidev export

Used an isolated copy of Artera's package manifest and lockfile, with the source checkout unchanged. The exporter verified a selected existing illustration's SHA-256, produced ordered source and references, and built with the locked Slidev version (52.19.0). PDF export produced two pages; the first page was rasterized and visually reviewed after fixing image sizing.

Local review artifact: `/home/ncrmro/repos/ai-outfitter/.local-data/creative-workflow/slidev-runtime/acceptance-deck-v4/artera-acceptance.pdf`. This is a concept review deck using an existing illustration with unknown historical generation provenance.

## Release boundary

No production installation was upgraded, no existing film was deleted, no real graph batch was auto-approved and no paid generation was submitted. The release operator must deploy the app packages and run the documented, hash-verified migration against each organization's authorized installations before advertising live cutover.
