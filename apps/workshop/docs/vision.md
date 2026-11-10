# Why Workshop exists

Workshop is for people building ambitious physical things: a solar sensor
node for a field study, a rover prototype for a robotics team, and one day
hardware that has to survive another planet. A design agent that can only
make a cable clip is a stepping stone toward that, not the goal. This page
is the long-term vision, and every eval, example and feature in Workshop
should say where it sits on it.

## Who asks, and what they are building

A design request without a project around it is a benchmark prompt. Workshop
works for a person with a project, so every eval and example names its
persona and project, says why the part exists (what it holds, mates with,
carries or protects), and says what evidence would retire the risk it
addresses. These are the people Workshop serves, in the order Workshop
grows toward them:

1. **A maker fixing something on their desk.** One printed part, dimensions
   known up front. This is what today's single-part evals cover. It is the
   smallest useful step, and never the finish line.
2. **A researcher or solo founder building a field instrument.** The SNY-1
   soil sensor node in Workshop's seed: an enclosure around a COTS devkit
   and sensors, a firmware build, and an inventory tracked by MAC address.
   The enclosure only matters because the devkit, probe slot, vent and solar
   panel have to fit.
3. **A small robotics team building a prototype on a budget.** Several
   sub-assemblies, printed tooling around COTS motors, bearings, rods and a
   microcontroller, mounting patterns taken from datasheets, a BOM that can
   be ordered for about $1,000, parts that move, and a validation record
   that says what the CAD proves and what only the bench can. The reference
   for this level is a motor coil winder prototype (see below), and it is
   the level we evaluate models against (DGX Spark against hosted models).
4. **A team with a mission.** A Mars-rover-class project: environment,
   mass and power budgets, redundancy, long test campaigns, and a record
   that traces every requirement to the evidence behind it. Workshop never
   claims to design this alone. It keeps the record honest and makes the
   design agent useful at each stage.

## The ambition ladder

Each tier is defined by what a project needs, not by how hard the geometry
is. A tier is reached when the design agent produces it from a persona's
request and the eval scores it against a reference. The scoring that exists
today is in `box/README.md` ("Geometry scoring").

| Tier | What the project needs | Reference | Scored by | Status |
| --- | --- | --- | --- | --- |
| 0 | One printed part from a dimensioned description | `agent-evals/evals/*` (cable clip, mounting plate, L bracket, flanged bushing) | Code runs, watertight, volume IoU, Chamfer and Hausdorff distance | Passing on Luna and Spark |
| 1 | One part that mates with something: a hole pattern for a devkit, a bore for a bearing, a snap or press fit | New fixtures with a COTS envelope beside the part | Tier 0, plus clearance and interference against the envelope | Needs richer CAD plans (below) |
| 2 | A static assembly: printed parts and COTS placed together, with a BOM | `examples/mini-itx-case` (printed case around a board, cooler and power supply), SNY-1 sensor node (`src/lib/sensor-node.ts`) | No interference between items, holes on bosses, connectors through openings, BOM matched against a reference BOM | Hand-built example and model; no agent has produced it yet. The case's parts are evals the DGX Spark runs one at a time (`agent-evals/evals/case-*`): all six pass as of 2026-11-10, two after prompt fixes; no model has produced the whole case yet (`agent-evals/FINDINGS.md`) |
| 3 | A moving assembly: joints with a range of motion, gears that mesh, nothing collides while it moves | `examples/spinning-wheel`, `examples/gear-pair` | Interference swept over the motion range, ratio and range of motion | Hand-built seeds only |
| 4 | A COTS-driven prototype: six sub-assemblies, about 90 bodies, datasheet mounting patterns, a priced BOM, a motion program and a validation record | Motor coil winder prototype (below) | Tiers 1 to 3, plus structure and BOM against the reference, dimensions against its metrics file, interference sampled over the traverse, and the record: acceptance boundary, unclosed items, corrections | Target for model comparison |
| 5 | A mission: budgets, environment, redundancy, requirement traceability | To be chosen | Mostly the record: every requirement has evidence or an open risk | Vision |

The mini-ITX case is also how the DGX Spark climbs from tier 0 to tier 2:
each of its models is an eval of its own, from the purchased envelopes
(board, power supply, cooler) through the printed parts (base, top, shell)
to the assembly, with the same request a person would write and the
example's fit checks as the score. The hand-built example is the reference,
not a model's output; no model has produced it yet.

Public text-to-CAD benchmarks cover tier 0 and parts of tier 1
(BenchCAD, CAD-bench, Text2CAD-Bench, CADTests; see the eval README). They
stop at single parts, so tiers 2 and up are Workshop's own.

## Reference: a motor coil winder prototype

The tier 4 reference is a working design repository, not a prompt. One
person with about $1,000 is building a two-axis coil winder (printed
tooling, two stepper motors, a lead screw, linear bearings on 8 mm rods, a
small ESP32 board running open-source CNC firmware) in order to wind the
coils of a small electric motor they are also designing: two steel rotor
discs carrying magnets, a thin potted stator holding the coils, standard
608 bearings on an 8 mm shaft. A force bench and a two-motor gripper reuse
the motor. What the repository contains is what a tier 4 eval has to score:

- **Structure.** Six assemblies (winder, coil former, fixtures, motor,
  force bench, gripper), about 90 bodies, each part exported as STEP and
  STL in its own coordinates and each assembly as one STEP in placement
  coordinates. Purchased parts are envelopes carrying attachments and
  mounting interfaces (a NEMA 17 face, a hub with six holes on a bolt
  circle), so a printed part is checked against the pattern it mounts to.
- **Geometry Workshop cannot make today.** Rounded-trapezoid coil formers
  with fillets, a stator disc with lead channels, bolt circles, a shaft
  stack defined as a table of Z layers with a fixed gap between magnet faces.
- **A BOM with evidence.** About 30 lines in two purchase phases, each
  marked as a vendor-listed price with a URL and capture date or as an
  allowance, with notes on what to measure before buying.
- **Motion.** A winding program (G-code) replayed to check commanded turns
  and travel, and rigid-body clearance sampled at traverse positions, with
  no overlap above 0.1 mm³ allowed.
- **The record.** A validation page that separates software evidence from
  the unclosed physical acceptance (COTS dimensions, print shrinkage, step
  loss under wire tension, real air gaps), a list of the corrections the
  checks forced (motor platforms raised, a bearing bore reopened), a
  dimensioned revision document with a metrics file, and the line "do not
  treat a successful CAD export as fabrication acceptance".

A model under evaluation gets the persona, the budget and the goal, and is
scored on how much of that it produces and how well it matches: the
sub-assembly structure and part count, the BOM against the reference lines,
the dimensions against the metrics file, interference over the sampled
positions, and whether its record draws the same acceptance boundary. The
repository's own export, clearance and program checks are the model for
Workshop's eval steps at this tier.

## What has to change in Workshop

- **CAD plans** (`src/model/cad-plan.ts`) add and cut boxes and cylinders
  along the axes, up to 64 features and 300 mm per axis (raised from 24 and
  200 mm for the case parts). The ladder needs fillets, chamfers,
  countersinks, patterns, rotation about any axis, and profiles that are
  extruded or revolved (a gear tooth, a knob).
- **Assemblies** (`src/lib/assembly.ts`) already have items, revisions,
  sub-assemblies, COTS envelopes, firmware items and an indented BOM, in
  the shape PLM systems use. A usage places an item with a position and a
  turn about Z. The ladder adds full rotation, attachments and mounting
  interfaces on items (as the coil winder's part contract has), joints
  (revolute, prismatic) with limits, and mates between features, so a wheel
  can be told it turns on a post and a motor stand is checked against the
  motor's face pattern.
- **COTS envelopes** come from the manufacturer's drawing with their
  mounting pattern, and Workshop keeps a library of the ones projects use,
  so a devkit or a motor is placed once and fit-checked everywhere.
- **The design agent** produces an assembly and a BOM for a request, not a
  single part, and records the research decisions and evidence a project
  needs, because tier 4 scores the record as well as the geometry.
- **Evals** carry the persona and project in every fixture. A reference is
  an assembly with a BOM, not only an STL, and the interference check in the
  examples becomes an eval step that sweeps the motion range.

## How to add work to Workshop

Name the tier and persona in the PR. A new eval fixture states who is
asking and what project the part belongs to. A new CAD or assembly feature
says which rung it unlocks. Work that only moves toward "the next milestone"
without a persona behind it is a benchmark, and belongs in the comparison
set rather than in Workshop's own evals.
