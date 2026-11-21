# A home user designs an office shelf in Workshop

Status: research only, nothing built. Persona: Nicholas as a personal Outfitter
user, not an organization. Tier 2 of the [Workshop vision](../../apps/workshop/docs/vision.md)
(a static assembly of made parts around purchased ones, with a BOM), at furniture
scale instead of desk scale.

## The ask

> Design a bookshelf for my office at home. It must hold a UPS, a printer, a NAS,
> two DGX Sparks and some books. The lower part is closed, with an exhaust fan so it
> stays tidy and cool. Each thing it holds is modeled so it shows on the shelf, and
> it is built from off-the-shelf parts such as hinges.

The exact models of the UPS, printer and NAS do not matter yet. What matters is
that each one is a box with a size, a weight and the heat it gives off, so the
shelf can be laid out, checked and drawn around them.

## What happens today if he tries

1. **He can't install Workshop personally.** His personal scope has Forerunner,
   Governance, Onto, Planning and Wiki Map (live `Viewer`, Nov 16). Workshop's
   `app.json` has `catalog.access: "admin-only"` and no `catalog.personal: true`, so
   the member's own `/apps` page says it installs from an organization
   (`webapp/src/lib/app-directory.ts`), and `installUserApp` only lets platform
   admins install anything but Forerunner (`webapp/src/lib/user-apps.ts`). Onto and
   Wiki already carry `personal: true`; Workshop does not. The SDK already handles a
   user-owned installation (`owner.kind: "user"`, owner gets admin access), so the
   app code itself mostly works; the `StartWorkshopDesign` description still says
   "an organization owner or admin may start it".
2. **Planning would start the wrong project.** Personal Planning's `MutateProject`
   already takes requirements with `kind` (`mechanical`, `enclosure`, `hardware`),
   `components` (name, kind cots, manufacturer, MPN, quantity, cost), `dimensions`
   (with `verified`), `constraints` and `unknowns`, and `prepare` freezes a Workshop
   package and creates the Workshop project. That is the right front door. But
   `delivery-prepare.ts` always creates the project with `example: "node"` (the
   SNY-1 sensor node), so a shelf would start life as a sensor enclosure.
3. **The contents can be placed but not described.** Workshop items already have a
   `cots` kind, an envelope `geometry`, a manufacturer, MPN, source, cost and a
   `provenance` of provisional, manufacturer or measured. Assembly members may be up
   to 5 m (`AssemblyCadPlanSchema`), so a 1.8 m shelf fits. What items lack is mass,
   heat output, material and process: nothing can say "this shelf carries 25 kg"
   or "this cabinet must shed 400 W".
4. **There is nowhere to say "in Nick's office, at Nick's home".** Onto has `Asset`
   (a home, a vehicle) and `owns` from a Person, but no place type and no
   "located in" or "installed at" edge. Forerunner keeps places in its own seed
   (`place.home`), not as Onto types.
5. **Agents can't read the result back.** Saved Workshop models have no MCP read on
   main; draft apps#212 adds `WorkshopProjects`, `WorkshopProject(slug)` and
   `WorkshopUnits`. The fit, thermal and print checks are draft apps#211, not on
   main. Both are drafts, not merged.

## The flow we want

Every step is an existing document unless marked **new**.

1. **Install.** He opens `/apps`, picks Workshop, and it installs as his own app at
   `/apps/workshop/`, using his personal Onto. (**new**: `personal: true`.)
2. **Write the press release.** In personal Planning, `MutateProject` creates
   "Office shelf" with a short press release ("My office finally has a home for the
   lab: the Sparks, NAS and UPS live in a quiet closed cabinet under my books"),
   goals, and requirements (below). Unknown sizes go in as unverified dimensions,
   so Planning's own questions ask him to measure them.
3. **Record the context in Onto.** One staged batch in his personal Onto, which he
   reviews or tells an agent to approve:
   himself, his home, his office, the shelf as a product with revision A, the
   contents and bought parts as components, and the requirements. Entities below.
4. **Prepare.** `MutateProject` `prepare` freezes the Workshop package and calls
   `CreateWorkshopProject`, `DescribeWorkshopProject` and `SaveWorkshopAssembly`.
   The assembly has the shelf as the top item, one `cots` item per thing it holds
   (an envelope box with mass and heat), and `cots` items for hinges, the fan,
   grommets and shelf pins. (**new**: a blank starter instead of `node`.)
5. **Design.** `StartWorkshopDesign` asks the design agent to lay out the carcass,
   shelves, doors and vent around the envelopes. Panels are `fabricated` items (cut
   plywood), not printed parts. For real geometry the source lives in a personal
   repo (for example `ncrmro/office-shelf`, his GitHub is connected personally) and
   the workspace build runs it.
6. **Check.** The build checks, from draft apps#211, run on the candidate:
   interference between every panel and every envelope, a load check on the shelf
   spans, and a heat check on the closed cabinet. (**new**: furniture checks below.)
7. **Look at it.** The Workshop 3D view draws the shelf with each device on it, the
   BOM lists the hinges and fan with prices, and the saved preview images show up
   in the project list.
8. **Build and record.** He buys the parts, cuts the panels from the cut list,
   builds it, records a measured cabinet temperature as evidence, and marks the
   shelf installed in the office.

## Entities

Addresses use Onto's `Type:slug`. Types in **bold** do not exist yet.

| Record | Type | Notes |
| --- | --- | --- |
| `Person:nick` | Person | Linked to his `OutfitterUser` with `account_of` (not checked whether it exists yet). |
| `Asset:nick-home` | Asset | The home, `owns` from `Person:nick`. Exists as a type. |
| `Location:nick-office` | **Location** | A room. Properties: `kind` (home, building, room, area), floor size and ceiling height in mm, notes on outlets and the wall the shelf stands on. |
| `Product:office-shelf` | Product | What he is making. One-off, but it keeps the press release, product, revision chain. |
| `ProductRevision:office-shelf-a` | ProductRevision | `revision_of` the product; pins the Workshop design key once built. |
| `PhysicalComponent:dgx-spark` | PhysicalComponent, kind `cots` | One component, used twice. Same for `ups`, `printer`, `nas`, `books-row`. |
| `PhysicalComponent:cup-hinge-35mm`, `:exhaust-fan-120mm`, `:cable-grommet-60mm`, `:shelf-pin-5mm` | PhysicalComponent, kind `cots` | The bought parts. Manufacturer, MPN and datasheet when chosen. |
| `Requirement:holds-contents`, `:closed-lower-cabinet`, `:cabinet-exhaust`, `:fits-office-wall` | Requirement | `has_requirement` from the Planning project's Onto `Project`. |

| Edge | Exists? | Meaning |
| --- | --- | --- |
| `owns(Person:nick → Asset:nick-home)` | yes | |
| **`located_in(Location:nick-office → Asset:nick-home)`** | no | A place is inside a larger place or an asset. Endpoint types: from Location, to Location or Asset. |
| **`installed_at(ProductRevision:office-shelf-a → Location:nick-office)`** | no | Where a built thing lives. Interval edge (`@start`) so a move is a new edge, not an edit. |
| **`holds(ProductRevision:office-shelf-a → PhysicalComponent:dgx-spark)`** | no | The things a product is made to carry, with quantity. Different from `includes_component`, which is what it is built from. |
| `includes_component(ProductRevision:office-shelf-a → PhysicalComponent:cup-hinge-35mm)` | yes | What it is built from. |
| `revision_of`, `has_requirement`, `supplied_by` | yes | |

Prior art for places: schema.org `Place` with `containedInPlace`, and the building
model in IFC (site, building, storey, space). We only need the small version: one
`Location` type with a `kind`, and `located_in`. A home stays an `Asset` because
ownership and money hang off it; a room is a `Location` inside it.

In Workshop, the same contents become assembly items. Proposed additions to
`ItemSchema`, all optional:

| Field | Example | Why |
| --- | --- | --- |
| `mass` (g) | DGX Spark about 1,200 | Shelf load and tipping. |
| `power` (W, typical and peak) | DGX Spark up to 240 (its adapter rating) | Heat the cabinet must shed. |
| `clearance` (mm per side) | 50 behind the NAS for cables and air | Fit checks use the envelope plus clearance. |
| `material` | `plywood-18mm`, `PETG` | Already proposed in apps#211's findings. |
| `process` | `sheet-cut`, `fdm-print`, `bought` | Tells the checks and the cut list what applies. |
| `onto` | `PhysicalComponent:dgx-spark` | Links the item to its Onto record, so the catalog entry is shared. |

The device sizes start `provisional` (DGX Spark about 150 x 150 x 51 mm from its
published spec; the others as rough boxes) and move to `measured` when he measures
his own.

## Requirements as Planning would hold them

| Key | Kind | Statement | Acceptance |
| --- | --- | --- | --- |
| `holds-contents` | mechanical | Holds one UPS, one printer, one NAS, two DGX Sparks and about 1 m of books. | Every envelope plus clearance fits with no interference; each shelf deflects under 2 mm at its load. |
| `closed-lower-cabinet` | enclosure | The lower section is closed by doors on concealed hinges, with cable grommets at the back. | Doors close with every device in place; cables leave through grommets. |
| `cabinet-exhaust` | enclosure | A fan exhausts the closed cabinet so inside air stays within 10 °C of the room. | Heat check passes at typical load; measured temperature recorded after a day of use. |
| `fits-office-wall` | mechanical | Fits the chosen office wall and is anchored against tipping. | Footprint inside the measured wall space; wall anchor in the BOM. |

The UPS and the laser printer may want to live outside the closed cabinet (batteries
age faster when warm; laser printers get hot and need paper access). That is a
design decision for the agent to raise as a question on the batch, not a rule.

## The heat check is the interesting one

A rough number shows why the fan matters. Two Sparks, a NAS and a UPS under load is
a few hundred watts in a closed box. The usual cabinet airflow rule is
airflow (CFM) ≈ 1.76 × watts ÷ allowed rise (°C). At 400 W and a 10 °C rise that is
about 70 CFM, more than one quiet 120 mm fan moves against the back pressure of a
vent. So the check is a simple heat balance first (sum of item `power`, fan curve,
vent area), not a simulation. Draft apps#211's Gmsh and CalculiX thermal study is
the next step if the simple check is close. AV and server furniture makers sell
thermostat cabinet fan kits for exactly this, so the fan is a bought part with a
datasheet curve, not a design.

## Gaps to build, in order

1. **Workshop personal install.** Add `catalog.personal: true`, let members (not only
   platform admins) install it personally, and fix the "organization owner or admin"
   wording. Check that the workspace binding (`binding.approve`) and the design
   agent's `inference.generate` work for a user-owned installation; Forerunner's
   personal install is the prior art. Webapp + apps.
2. **Merge the read documents (apps#212)** so an agent and Planning can read the
   saved shelf, BOM and builds back. Write them against Relay connections
   (`workshopProjects(first:){nodes}`), which apps#215 and webapp#985 just made the
   shape for every app.
3. **A blank starter.** `CreateWorkshopProject` gains an empty example (or Planning
   picks the starter from requirement kinds), so `prepare` stops creating a sensor
   node for furniture.
4. **Item physics fields:** `mass`, `power`, `clearance`, `material`, `process`,
   `onto` on `ItemSchema`, filled by `SaveWorkshopAssembly` and shown in the BOM.
5. **Onto place types:** `Location`, `located_in`, `installed_at`, `holds`, in Onto's
   core seed (places are not hardware, so not Workshop's seed). One batch, his call.
6. **Furniture checks in the workspace build**, beside apps#211's: envelope plus
   clearance interference (reuses manifold3d), shelf deflection from a beam formula
   per span, the cabinet heat balance, and tipping. Each writes a `tests` line in the
   build manifest, so it shows as evidence.
7. **A cut list for sheet parts.** Panels with `process: sheet-cut` produce a cut list
   and sheet layout from the build, using an existing packer (for example the
   Python `rectpack` library) rather than our own; OpenCutList is the reference for
   what woodworkers expect to see.
8. **A COTS library.** Onto `PhysicalComponent` records (kind `cots`) are the catalog
   that any project reuses: a hinge or a Spark is defined once with its envelope,
   mass, power and datasheet, and a Workshop item links to it with `onto`. This is
   the "library of the ones projects use" the vision already asks for.
9. **Installed and in use.** After the build, a `RecordWorkshopUnit` for the shelf
   plus the `installed_at` edge, and the measured cabinet temperature as evidence on
   `ProductRevision:office-shelf-a`.

## What already works and needs nothing

- Planning requirements carry components, dimensions with `verified`, unknowns and
  questions; `prepare` hands off to Workshop with Workshop's own documents.
- Workshop's assembly is a real product structure: items, usages with position and
  full orientation, sub-assemblies, COTS envelopes, indented BOM and cost.
- Furniture-sized assembly members (up to 5 m) and mesh items from a workspace build.
- The workspace build: a project repo, the design and validate actors, and evidence
  tests on the manifest. His personal GitHub connection is active.
- Personal Onto for the records, with batches he reviews or has an agent approve.

## Decisions for Nicholas

1. Workshop personal for every member, or only platform admins during alpha?
2. Places in Onto's core types (`Location`, `located_in`, `installed_at`), or does
   Forerunner own places and Onto only reference them?
3. The COTS library as Onto `PhysicalComponent` records (shared across Workshop
   projects and organizations through shares), or a Workshop-only table?
4. First proof: this shelf as the tier 2 furniture eval beside the Mini-ITX case,
   or only as his own project?
