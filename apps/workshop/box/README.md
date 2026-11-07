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
- `evals/`: Agent Eval fixtures and `run.ts`.

The design agent runs on the platform (the webapp's `src/lib/workshop-design.ts`),
so the platform gets the model settings; the box signs in as the local member.

```sh
docker build --build-context webapp=../webapp --build-arg BOX_APP=workshop \
  -f box/Dockerfile -t outfitter/workshop-box:dev .
BOX_CLI=podman BOX_MODEL_ENV=spark.env node --import tsx apps/workshop/box/evals/run.ts cable-clip
```
