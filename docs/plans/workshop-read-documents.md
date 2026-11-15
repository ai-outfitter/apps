# Workshop read documents, and the Workshop UI reading through them

Status: the documents and two UI readers are built (this PR). The rest of the
page is a plan.

## Built

Workshop publishes three reads to MCP clients, typed in
`apps/workshop/src/server/read.ts` and listed in `src/server/documents.ts`:

| Document | Reads | Federated |
| --- | --- | --- |
| `WorkshopProjects` | slug, stage, kind, brief, product revision | yes, `organizationSlug` on each record |
| `WorkshopProject(slug)` | requirements, assembly items and usage lines (by part number), indented BOM and cost, builds with tests, artifacts and built assembly, evidence, research, concepts | no, one scope |
| `WorkshopUnits` | units by part number, MAC, status, project, firmware | yes |

`WorkshopProject` is a selection of the `workshopProjects` collection with
`slugs: [$slug]`, so there is one project type, and the same type answers every
project mutation. A slug matches on the last 12 hex digits of the id, as the
page's links do, so renamed projects keep their old addresses.

Readers that already go through the documents:

- The projects list (`GET /api/apps/workshop/projects`) runs `WorkshopProjects`.
- Ask Workshop's page context runs `WorkshopProjects` and, on a project page,
  `WorkshopProject`, so the assistant and an MCP agent see the same record.

## Not yet: the project page

The project page (`src/client/workspace.ts`) loads the whole project document
(`GET /projects/<id>`, up to 1.5 MB) and edits it in the browser: geometry,
parameters, research, evidence. That is an editor, not a read, and it stays on
the whole-document route until the edits it makes have mutations of their own.

What can move now, in order:

1. **BOM and Revisions sections** render from `WorkshopProject` (`bom`,
   `builds`), not from the client's own `bomRows` over the loaded document.
   Needs one route, `GET /api/apps/workshop/documents/<Name>` that runs a
   published read with the member's identity (as the list route does), or a
   page-level `runDocument` in the Astro page with the result inlined.
2. **Retire `WorkshopProjectHandoff`.** Planning's delivery readback
   (`apps/planning/src/server/delivery-read.ts`) calls it with a JSON answer;
   switch it to `WorkshopProject` and delete the handoff field.
3. **Model section.** The 3D view needs geometry and placements, which
   `WorkshopProject` now serves; the editor still saves the whole document.
   Moving edits to `DescribeWorkshopProject`, `SaveWorkshopAssembly` and new
   mutations for research and evidence would let the page drop the
   whole-document read entirely.

## Open questions

- Should a project's slug become a stored, unique column (as Onto slugs are)
  rather than name plus id tail? Today's form is stable across renames and
  needs no migration.
- The quality and simulation plan (docs/plans/workshop-quality-and-simulation.md)
  adds Material, Item.material, Item.process and Item.physical; each would be a
  field on `WorkshopItem` in `WorkshopProject` when it lands.
