# Workshop read documents, and the Workshop UI reading through them

Status: the documents and two UI readers are built (this PR). The project page
is a plan.

## Built

Workshop publishes these reads to MCP clients:

| Document | Reads | Federated |
| --- | --- | --- |
| `WorkshopProjects` | slug, stage, kind, brief, product revision (id and revision with includeIdentifiers) | yes, `organizationSlug` on each record |
| `WorkshopProject(slug)` | requirements, notes, builds with tests and artifacts, evidence, research, concepts | no, one scope |
| `WorkshopUnits` | units filtered by part number, MAC, status, project, with firmware | yes |
| `ResolvedWorkshopAssembly`, `WorkshopAssembly` (already on main) | the model: expanded CAD, BOM, power and build price; the saved assembly for edits | no |

`WorkshopProject` is a selection of the `workshopProjects` collection with
`slugs: [$slug]`. The collection is the SDK's table collection (ids, orderBy,
filter, search, Relay paging) with its rows typed in
`apps/workshop/src/server/read.ts`. A slug matches on the last 12 hex digits of
the id, as the page's links do, so renamed projects keep their old addresses.

Readers that already go through the documents:

- The projects list (`GET /api/apps/workshop/projects`) runs `WorkshopProjects`.
- Ask Workshop's page context lists projects through `WorkshopProjects`.

## Not yet: the project page

The project page (`src/client/workspace.ts`) is a viewer plus build requests.
It never saves the stored project. It looks the slug up in the project list,
downloads the whole stored project (`GET /projects/<id>`, up to 1.5 MB), and
works out the BOM, totals and 3D placements in the browser.

What can move, in order:

1. **Load by slug.** One `WorkshopProject` read replaces the list lookup and
   gives the Revisions section its builds, tests and artifacts. The artifact
   file links need adding to the build type.
2. **Model and BOM sections** read `ResolvedWorkshopAssembly`, so the page, the
   assistant and agents agree on references, configurations and build price.
   Documents run in process are capped at 256 KiB, so a large resolved
   assembly needs a size check first.
3. **Retire `WorkshopProjectHandoff`.** Planning's delivery readback
   (`apps/planning/src/server/delivery-read.ts`) calls it for a JSON answer;
   switch it to `WorkshopProject` plus `WorkshopAssembly` and delete it.

## Open questions

- Should a project's slug become a stored, unique column (as Onto slugs are)
  rather than name plus id tail? Today's form is stable across renames and
  needs no migration.
- The quality and simulation plan (docs/plans/workshop-quality-and-simulation.md)
  adds Material and item properties; those belong in the assembly reads.
