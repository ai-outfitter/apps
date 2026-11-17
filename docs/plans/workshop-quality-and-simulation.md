# Quality checks, materials and simulation for Workshop models

Status: checks and studies built in the workspace build (section 5), run on
both models in a local Workshop box image. The entities in section 3 are still
proposed: until they exist, material values live in each `workspace.json`.

## The question

Workshop now holds real customer hardware. Three things were asked:

1. What existing quality, lint and static-analysis tools fit these models?
2. Do the models name materials well enough to simulate later?
3. Can we run simulation (structural, thermal) on them?

## What was checked

- Workshop's model code: `apps/workshop/src/lib/assembly.ts` (items, usages,
  BOM), `src/model/cad-plan.ts` and `src/model/geometry.ts` (box and cylinder
  features built with replicad on OpenCascade, exported to STEP and STL by
  `box/export.ts`), `src/lib/workspace.ts` and `box/workspace/build.py`
  (project-repository builds with OpenSCAD).
- The models behind the live projects. Planning holds a Mini-ITX case project
  whose reference is `apps/workshop/examples/mini-itx-case`, and
  a solar soil sensor node, whose starter is
  `src/lib/sensor-node.ts`.
- Not checked: the saved Workshop project records themselves. Workshop
  publishes no read document over MCP (only `WorkshopDesignRun`,
  `StartWorkshopDesign` and the creative handoff mutations), so an agent cannot
  open a project, its assembly or its builds. That is a gap of its own: a
  `WorkshopProjects` read is the first thing any of the checks below needs if an
  agent is to run or report them.

## 1. Quality checks

### Already in Workshop

| Check | Where | What it catches |
| --- | --- | --- |
| Schema rules | `AssemblySchema` (zod) | duplicate IDs or part numbers, missing children, an assembly inside itself, firmware with geometry |
| CAD plan bounds | `cad-plan.ts` | first feature must add, 300 mm per axis per part |
| Solid validity | `build.py` with trimesh | watertight, consistent winding, positive volume per OpenSCAD target |
| Fit checks | `build.py` `checks` with OpenSCAD intersection | overlap volume between named solids, empty means pass |
| Geometry scoring | `agent-evals`, `tests/box-geometry.unit.test.ts` | IoU >= 0.95 and 0.5 mm surface distance against a reference STL |

Results land in `BuildManifest.tests` (`pass`, `fail`, `unverified`), which is
the right place for everything below: no new record, just more tests per build.

### Gaps the two models show

- Fit checks are hand-written in each repository's SCAD (`case.scad` has
  `interference`, `standoff-fit`, `io-fit`). The assembly already knows every
  placed solid (`placements()`), so pairwise interference could come from the
  data for every project, as the mini-ITX README asks for.
- Nothing checks printability. The case shell is 224 x 178 x 83 mm and its BOM
  note says it needs a 230 x 185 mm bed or a split; the "300 g of plastic" claim
  is not measured anywhere.
- Nothing lints the BOM: SEN-F001 firmware has an empty repository, most COTS
  items are `provenance: provisional` with `priceKnown: false`, envelopes have
  no mass.

### Existing tools that fit (all open source, all run locally in the box image)

| Need | Tool | Notes |
| --- | --- | --- |
| B-rep validity of the STEP | OpenCascade `BRepCheck_Analyzer` | Already linked through replicad; no new dependency |
| Mesh repair and defects | trimesh (have), manifold3d, PyMeshLab, admesh | manifold3d also gives fast exact Booleans for data-driven interference |
| Interference and clearance from the assembly | manifold3d or OpenCascade Booleans over `placements()` | Replaces per-repo SCAD checks; clearance = distance query on the same pairs |
| Printability (bed fit, overhangs, supports, time, grams) | PrusaSlicer CLI (`--export-gcode`, `--info`) or CuraEngine headless | Slicing gives real filament mass and print time per part and fails on bed overflow |
| Thin walls and overhang angles | PrusaSlicer warnings; trimesh face-normal pass for overhang | Cheap first pass before slicing |
| PCB (sensor node rev B) | `kicad-cli sch erc`, `kicad-cli pcb drc` | Only once a KiCad board exists |
| Firmware config | `esphome config` | Belongs to Foundry's checks, listed here because the item names it |

Recommendation: add the slicer and data-driven interference to `build.py`
first. They need no new data, find real problems in both models today
(shell bed size, measured grams), and report through the existing
`BuildManifest.tests`.

## 2. Do the models record materials?

No, not in a form a simulation can use.

- `ItemSchema` has no material field. Material appears only as free text:
  the sensor-node base note "PETG or ASA for outdoor use", the lid has none, and
  the mini-ITX `bom.csv` note "PETG; flat side down" lives in the example
  repository, not in the record.
- `AcceptCreativeHandoff` takes `materials` as an optional free-text string.
- COTS parts are dimensioned envelopes with no mass, no power dissipation and no
  operating temperature range, which are exactly what a thermal model needs
  (the CPU cooler and PSU in the case, the ESP32-S3 and charger in the sensor node).
- Printed parts carry no print settings. FDM parts are anisotropic and their
  strength depends on infill, wall count and build orientation, so a material
  name alone is not enough.

## 3. Proposed entities (for review before code)

- **Material**: a named grade with the properties simulation and checks read:
  density, Young's modulus, Poisson's ratio, yield or tensile strength,
  thermal conductivity, specific heat, glass transition or max service
  temperature. Seeded from datasheets for PLA, PETG, ASA, PA12, 6061-T6 and
  FR-4, each with its source URL. Where it lives is open: a Workshop seed table,
  or Onto records other apps can read.
- **Item.material**: a material reference on `printed` and `fabricated` items.
- **Item.process** for printed items: process (FDM, SLA, SLS), layer height,
  walls, infill percent, build orientation. A knock-down factor on strength
  between layers comes with it.
- **Item.physical** for COTS items: mass, heat dissipated in watts, operating
  temperature range. All optional, with the existing `provenance`.
- **Load case** on a project: what the part must survive (screw torque on a
  boss, a 1 m drop, 40 °C ambient with full sun, CPU at 65 W), with a pass
  criterion. Simulation results become `BuildManifest.tests` against these.

## 4. Can we simulate?

Yes, for first-order answers, with mature local tools and the STEP files
Workshop already exports.

| Analysis | Tools | First use |
| --- | --- | --- |
| Static stress | Gmsh (mesh from STEP) + CalculiX | Mini-ITX standoff bosses under screw load; Sensor node lid screw bosses |
| Steady and transient heat | Elmer FEM or CalculiX thermal | Sensor node in full sun: does PETG pass its ~80 °C glass transition, does the SCD41 stay in range |
| Lumped thermal network | a few lines over Item.physical | Mini-ITX case: CPU and PSU watts against vent area, before any CFD |
| Airflow (CFD) | OpenFOAM | Only if the lumped model says the case is marginal; heavy to set up |
| Orchestration | FreeCAD FEM (headless) wraps Gmsh, CalculiX and Elmer | Option if we want one tool instead of three |

Limits to state on every result: FDM parts are anisotropic and infill-dependent,
so results are estimates with derated properties, and they are evidence of
`unverified` strength until a printed part is tested (Workshop's `evidence`
stages already include Fit test and Measurement). Workshop's CAD plans are boxes
and cylinders without fillets, so stress concentrations at sharp corners will
read high.

## 5. Built: checks and studies in the workspace build

`apps/workshop/box/workspace/quality.py`, called from `build.py`, configured
in `workspace.json` (keys in `apps/workshop/box/README.md`, "Quality checks and
studies"). The Workshop box image gains PrusaSlicer, CalculiX, Gmsh and
manifold3d in its existing Workshop-only step; other apps' images are unchanged.
Every result is a `BuildManifest.tests` row, with the numbers in `quality.json`.

Run on the two models (`examples/mini-itx-case`, `examples/sensor-enclosure`):

| Model | Check | Result |
| --- | --- | --- |
| Mini-ITX case | Bed fit, 220 mm bed | Fail: base, shell and top are each 224 mm wide (the README only flagged the shell) |
| Mini-ITX case | Plastic | 384 g PETG (91 + 194 + 98), not 300 g; about 34 h of printing |
| Mini-ITX case | Interference | Pass on 15 pairs, agreeing with the hand-written check; moving the PSU 10 mm fails it with the same overlap OpenSCAD measures (38,060 vs 38,044 mm3) |
| Mini-ITX case | Standoff boss, 500 N clamp | Fail: 25 MPa under the screw head against 23.5 MPa allowed; a washer fixes it |
| Sensor node | Bed fit, plastic | Pass: 111 g PETG, about 9.5 h |
| Sensor node | Full sun at 40 C | Fail: lid about 93 C (PETG deflects at 68 C), inside air about 55 C (SCD41 limit 50 C, LiFePO4 charging 45 C) |

`box/workspace/test_quality.py` checks the code against hand calculations
(Fourier conduction through a slab, force over area in a column, overlap of two
cubes, footprint rotation). The studies are first estimates: one film for wind
and radiation, well-mixed inside air, derated datasheet strength.

## Recommended order

1. Add a `WorkshopProjects` read document so agents can see the models and
   their build tests.
2. Done (section 5): slicer, interference and CalculiX studies in `build.py`.
3. Agree the entities in section 3, then add Material, Item.material,
   Item.process and Item.physical.
4. Done as a pilot (section 5): Sensor node in full sun with CalculiX. Next: read
   load cases and materials from the records once section 3 exists.

## Decisions needed

- Where Material records live: Workshop table or Onto records.
- Which printer bed the checks assume. The examples use 220 x 220 mm (Ender-3
  class); a printer record per organization would replace it.
- What to do about Sensor node in the sun: shade, a white lid, vents or a gap under
  the panel. This is a product decision for the hardware owner, not a Workshop one.
