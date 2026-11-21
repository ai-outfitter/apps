# Workshop

Workshop is an Outfitter app for physical product projects: the record, the CAD and the design agent for people building ambitious hardware, from a field sensor node to a robotics prototype. [docs/vision.md](docs/vision.md) is the long-term vision and the ambition ladder every eval and example sits on. It includes a read-only demo and an operational mode with an installation database, storage and Wiki dependency. Its catalog access remains restricted to administrators.

Run `npm run check --workspace apps/workshop`, `npm run test --workspace apps/workshop`, and `npm run build --workspace apps/workshop` from the repository root. Browser tests require Playwright Chromium. Packages are written to `.outfitter/packages/` for the shared release tooling.

## Saved previews and visual evidence

The project list loads authenticated PNGs, never CAD workers or mesh files.
`box/capture-previews.mjs` runs in the sealed container (or a workspace with
Chromium), waits for the assembly viewer, captures a preview and desktop/mobile
screenshots, then publishes revision-bound evidence through the preview API.
The box drivers capture completed work and check for new revisions every 30 seconds.
A missing capture leaves the image absent until that pass completes; an index page
never starts a render as a fallback. Failed captures are logged and retried.

Run `node /app/.box/apps/workshop/box/capture-previews.mjs` inside an existing
box to backfill; add `--watch` when running the capture worker independently.
The shared `box/capture-evidence.mjs` helper owns viewport sizes, readiness,
PNG capture; applications own hashing and authenticated publication. Workshop
uses shared artifact references and the private build-artifact storage space.
`GET /api/apps/workshop/projects/:id/preview?revision=N&evidence=1` returns the
capture record, hashes, dimensions, build/source identity and artifact keys.
It proves rendered appearance, not physical or functional validation. Captures
retain the existing build-storage one-year retention and expire with that storage.
## Workspace assemblies

Model source belongs to a project repository. Workshop reads immutable component
meshes, assembly structure, BOM and test evidence produced in a workspace.
The browser inspects results; builds run in Kubernetes workspaces or the shared
sealed app box for local development. See [box/README.md](box/README.md).
Project-specific models and dimensions must never be added to app source.
## Sidebar assistant

Ask Workshop opens the shared private conversation sidebar on every page, including
New model. It reads up to 20 saved projects with assembly items and current build
evaluations (vision tier 2 inspection). It cannot modify models or start builds;
the existing creation and workspace flows perform those actions. Conversations use
the platform thread service and the installation-scoped agent tables. Demo replies
are scripted. Operational installations need `threads.use` and `threads.provide`.

## Starting design work from outside the page

`StartWorkshopDesign` starts the design agent on a part or project request with
one GraphQL mutation and answers the run at once; `WorkshopDesignRun` reads it
until the project revision is saved. Both are published to MCP clients, and
the platform's `StartTasks` starts the same `workshop-design` task. See
[box/README.md](box/README.md) for the evals that drive this path.

The [assembly file MCP eval](agent-evals/mcp/evals/attach-assembly-files/README.md) runs a live agent through discovery, file uploads, a concurrent edit and stored-byte verification using Vercel Agent Eval.

## Products and component library

For tier 2 assembly builders, `purpose: "product"` identifies the hardware they
intend to manufacture. `purpose: "component"` identifies a purchased component
or reference model they reuse. The home page opens on Products; Component
library and All models remain available. Model purpose can be changed on a
model page, or through `DescribeWorkshopProject` / `ProjectChanges` using the
observed revision. Creation also accepts `purpose`.

This is independent of mechanical/electronics kind, manufacturing phase and an
assembly item's COTS/printed/fabricated kind. No models are reclassified from
names or child parts. Existing documents and migration 0007 default to product;
classify established component models explicitly after release. The underlying
record IDs, URLs, files, historical assemblies and cross-model references stay
unchanged. `WorkshopProjects` accepts `filter.purpose.equalTo` for discovery;
REST listing continues to return both purposes for existing reference consumers.

Normal official catalog publication follows app PR review/merge and successful
main CI: the separate catalog publication job sends the checked artifacts, and
the platform reconciles installations. Verify the active Graph contract before
classifying existing records. A branch push or preview is not activation; a
separate component release is not required by this catalog pipeline.
