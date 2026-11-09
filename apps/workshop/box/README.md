# Workshop box

Workshop's design agent as one sealed container. A repository and a folder of
design requests go in. For each request the box has Workshop's design agent
make the project (the first message, then each follow-up), builds the model
with Workshop's own geometry, and commits the design revision to the default
branch under `designs/<slug>/`: `project.json`, `model.step`, `model.stl` and
`bom.json`. The files are also stored in the box's RustFS. Requests that ask
for a release are tagged, and a Forgejo release links an evidence bundle that
pins each design's commit and file hashes.

| Schema | What it describes |
| --- | --- |
| `schemas/design-request.schema.json` | One design request (`/in/requests/*.json`) |
| `schemas/design-result.schema.json` | What the box made of it (`/out/results/<requestId>.json`) |
| `schemas/evidence-bundle.schema.json` | A release's build identity and the files behind each design |

The schemas are generated from `src/box/contract.ts`; after changing it run
`node --import tsx scripts/box-schemas.ts`. `tests/box.unit.test.ts` checks the
fixtures, the export and the documents; `tests/box-driver.unit.test.ts` runs
the driver against a stand-in platform and a local git remote.

- `driver.mjs`: the box's work once the platform is up (see `box/README.md`
  at the repository root for the harness).
- `intake.mjs`, `results.mjs`, `release.mjs`: request checks, the BOM and
  design-result, and the release with its evidence bundle (the shared
  `box/release.mjs` step), as the Software Foundry box splits them.
- `export.ts`: builds a project's model with `src/model/geometry.ts` and
  writes STEP and STL.
- `evals/`: Agent Eval fixtures and `run.ts`. Each fixture is a part described
  with its dimensions, in the style of Text2CAD's expert prompts and CADPrompt's
  parts, limited to what Workshop's CAD plans make (boxes and cylinders, added
  or cut): `cable-clip`, `mounting-plate`, `l-bracket`, `flanged-bushing`.
  These are tier 0 of the ambition ladder in `../docs/vision.md`; the ladder
  runs to COTS-driven moving assemblies, and new fixtures name their persona
  and project. The `case-*` fixtures are the Mini-ITX case of
  `../examples/mini-itx-case` one model at a time, in the order a model should
  climb them: the purchased envelopes `case-board`, `case-psu` and
  `case-cooler`, then the printed `case-base`, `case-top` and `case-shell`.
  Their references are rendered from the example's `case.scad`, and CAD plans
  allow up to 64 features and 300 mm per axis so the printed parts fit.
  Public text-to-CAD benchmarks score single parts the same way and are the
  comparison set for tier 0 and 1: BenchCAD (46 CAD operations, where
  frontier models score near zero on fillets, chamfers and revolves),
  CAD-bench (179 tasks, accepts agent harnesses that output STEP),
  Text2CAD-Bench (600 examples in 4 levels) and CADTests (pass/fail
  dimensional tests). Most are in CadQuery, so running them needs a CadQuery
  or STEP output from Workshop. Its
  `reference/model.scad` is the part in OpenSCAD, rendered to
  `reference/model.stl`; `EVAL.ts` scores the box's `model.stl` against it
  (box/README.md, "Geometry scoring") and passes at IoU >= 0.95 with no surface
  more than 0.5 mm off. `tests/box-geometry.unit.test.ts` checks that a correct
  CAD plan passes each and a wrong one fails.

The design agent runs on the platform (the webapp's `src/lib/workshop-design.ts`),
so the platform gets the model settings; the box signs in as the local member.

```sh
docker build --build-context webapp=../webapp --build-arg BOX_APP=workshop \
  -f box/Dockerfile -t outfitter/workshop-box:dev .
BOX_CLI=podman BOX_MODEL_ENV=spark.env node --import tsx apps/workshop/box/evals/run.ts cable-clip
BOX_CLI=podman BOX_MODEL_ENV=spark.env node --import tsx apps/workshop/box/evals/run.ts case-board case-psu case-cooler case-base case-top case-shell
```
