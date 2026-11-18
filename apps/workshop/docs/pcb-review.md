# KiCad PCB review in Workshop

The PCB project section renders a KiCad-exported GLB and a review record (`<sha256>/pcb-review.json`) from an imported snapshot or a workspace build. It shows a searchable populated-reference BOM, part details, power estimates, configured electrical-check results, supplier-quote status and manufacturing downloads.

- **Imported snapshots:** the latest import opens by default. `?snapshot=<id>` selects exactly one historical import. Imports are member-uploaded file evidence, never hosted workflow results. `?build=` explicitly selects the workspace path.
- **Which build:** `?build=<id>` shows exactly that build, or says it was not found. It never falls back to another build. Without `?build=`, the page shows the project's current build. A historical build is labelled as such.
- **Where it appears:** the project root opens PCB review when an imported snapshot exists or the current build carries exactly one review record. Otherwise it opens the normal CAD view, and the PCB sidebar link is hidden. Demo mode has no board data and never calls the API.

## Data and provenance

Board files stay in installation-scoped build storage, and no board data is embedded in public app assets.

**Review record.** It is validated with `PcbReviewSchema` (`src/lib/pcb-review.ts`).
- Every model, download and quote-evidence path must be a registered artifact in the build manifest.
- The model must be `model/gltf-binary`. An optional `preview` must be a registered PNG; it is shown as a static rendering if interactive 3D fails.
- The existing workspace import checks verify each artifact's byte length and SHA-256 before a build can become current.

**Facts that pin the revision.** These come from the build record, not the review: build id, finish time, project revision, source commit, source archive hash, review record hash and runner.
- The source archive is the exact export input. The commit is only the repository base it was taken from, and it may not contain uncommitted ECAD files.
- The review's `boardSha256` is labelled as a registered file only when it matches one.

**Rendering.** The page renders the exported geometry itself, not a CAD-plan envelope. The review record states missing library bodies and export warnings.

**Quotes.**
- A quote with `total: null` is pending, blocked or not requested. It shows its status and never a price.
- A price appears only when the record has all of these: a positive `total`, `currency`, `supplier`, `quoteId`, `quotedAt`, assembly `scope` and a registered `evidence` file. Totals are never derived or estimated. Member-imported quote records are labelled unverified: an attached file is evidence to inspect, not authentication of the supplier.

**Power.**
- The input voltage comes from `power.inputVoltageV`.
- The margin label comes from `power.marginPercent` with `input_w_with_margin`. Older records name a fixed 20% margin in the `input_w_plus_20pct` field.
- Without a stated voltage, the page says so.

**Retention.** The build record is immutable, but its files live in the `builds` storage space, which has a one-year retention. If a file is missing, the page says whether the build is past that age or the file is missing earlier.

## Extending

Two pieces in `src/client/pcb-review.ts` divide the work:
- `loadWorkspacePcbSource` turns a workspace build into a `PcbReviewSource`.
- `renderPcbReview` renders any `PcbReviewSource`.

Another record type, such as an imported snapshot, needs only its own loader and a `PcbProvenance` variant. Label each source by what it actually is. A workspace import is not a validated hosted workflow run.

## Commands

```sh
npm run build --workspace apps/workshop
npm run check --workspace apps/workshop
node --import tsx apps/workshop/scripts/import-pcb-review.ts <workshop-url> <package-directory> <project-id> [--cdp <url>]
node apps/workshop/scripts/verify-pcb-review.mjs <workshop-url> <package-directory> <project-slug> [cdp-url]
```

The verifier is an engineering-snapshot acceptance check against a local installation. It checks:
- WebGL readiness and one canvas, on a fresh load and on a reload.
- BOM row count, filtering and selection.
- Each download's hash against the package manifest.
- ZIP delivery and loading on mobile.

### Import from an Outfitter workspace

Use the organization's Workshop installation in MCP. Query `WorkshopProjects` with identifiers to find the project and its revision, or use `CreateWorkshopProject` with an example and name. Call `SubmitWorkshopPcb` with the project ID, observed revision, a stable snapshot UUID, the package manifest and its content-addressed review path. For each entry in `uploads`, PUT the corresponding file bytes to its presigned URL using the returned headers. Repeat the same mutation to finish or refresh expired tickets. The saved receipt includes the snapshot ID, project revision and PCB path relative to the organization's Workshop mount.

## Snapshot import

The project PCB API verifies content hashes, lengths, MIME types and the registered native board hash before appending an immutable snapshot. It preserves CAD assemblies and validated workflow history. Generic project creation and saves cannot forge or rewrite snapshots. Imports allow 50 files, 30 MB and no assembly geometry; the project holds up to 30 snapshots within its existing document-size cap. Per-project upload quotas include abandoned uploads, which expire with build storage after one year. Deterministic snapshot IDs let importer retries reuse partial uploads. Individual files and a ZIP bundle remain downloadable.
