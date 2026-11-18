# Workshop box

Workshop's design agent as one sealed container. A repository and a folder of
design requests go in. For each request the box has Workshop's design agent
make the project (the first message, then each follow-up), builds the model
with Workshop's own geometry, and commits the design revision to the default
branch under `designs/<slug>/`: `project.json`, `model.step`, `model.stl` and
`bom.json`. The files are also stored in the box's RustFS. Requests that ask
for a release are tagged, and a Forgejo release links an evidence bundle that
pins each design's commit and file hashes.

After each design turn the box opens the project's design workbench in the
image's Chrome, signed in as its member, and saves a screenshot once the 3D
view has drawn: `/out/screenshots/<requestId>/<n>-<step>.png`, also in RustFS
and listed under `screenshots` in the design-result. An eval run copies them to
`agent-evals/results/<experiment>/screenshots/<eval>/`.

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
- `screenshots.mjs`: the workbench screenshots after each design turn.
- `export.ts`: builds a project's model with `src/model/geometry.ts` and
  writes STEP and STL.
- `../agent-evals/`: the Agent Eval project (`evals/` fixtures, one experiment per model in `experiments/`, `run.ts`). Each fixture is a part described
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

The design agent is Workshop's own (`src/server/design.ts`, prompt in
`agent/design-agent.md`): each turn starts a `workshop-design` workflow run and
asks the platform for one model answer through the workflow host's
`inference.generate`, so the platform gets the model settings and meters the
call to that run. The box signs in as the local member.

```sh
docker build --build-context webapp=../webapp --build-arg BOX_APP=workshop \
  -f box/Dockerfile -t outfitter/workshop-box:dev .
BOX_CLI=podman node --import tsx apps/workshop/agent-evals/run.ts spark cable-clip
BOX_CLI=podman node --import tsx apps/workshop/agent-evals/run.ts spark case-board case-psu case-cooler case-base case-top case-shell
```

### Starting design work through the graph API

Design work also starts with one GraphQL mutation, `StartWorkshopDesign`
(`src/server/design-start.ts`), which Workshop publishes to MCP clients with
`WorkshopDesignRun`. The mutation checks the request as a design turn does,
starts a `workshop-design` task run through the workflow host's `task.start`
and answers at once; the platform then dispatches the task to Workshop, which
runs the same design turn on that run. The platform's own `StartTasks` starts
the same task. An organization owner or admin may start it.

A request with `"via": "graphql"` sends every turn that way: the driver calls
`graph_mutate` on the platform's MCP dispatch as the signed-in member (the
local session adapter at `/debug/mcp/rpc`, the same dispatch `/mcp` serves an
OAuth client), reads `WorkshopDesignRun` until the run is complete, and reads
the project it saved. Everything after the turn is unchanged, so a fixture's
`EVAL.ts` grades both paths with the same geometry scores. The experiments
`luna-graphql` and `spark-graphql` run every fixture this way on the same
model settings (`.env.luna`, `.env.spark`), into `results/<experiment>/`:

```sh
BOX_CLI=podman node --import tsx apps/workshop/agent-evals/run.ts spark-graphql cable-clip
BOX_CLI=podman node --import tsx apps/workshop/agent-evals/run.ts spark-graphql case-board case-psu case-cooler case-base case-top case-shell
```

These are the tier 0 parts and the tier 2 case parts of `../docs/vision.md`
again, reached the way an agent outside Workshop reaches them. A failure here
that the design-route experiment passes is in the mutation, the task dispatch
or the graph API, not the design agent.

## Repository-owned assemblies (tier 2)

Set `BOX_WORKSPACE=1` to use the same sealed platform, gateway and workspace
runtime as Software Foundry. The designer edits a connected project checkout;
a separate validator rebuilds its committed candidate. Workshop then verifies
artifact hashes and records the assembly, BOM and checks as an immutable build.
The browser renders the returned meshes and queues revision requests. It does
not execute the project's OpenSCAD or Python source.

Build the standard image above, or iterate from an existing sealed box image:

```sh
podman build -f box/Dockerfile.dev \
  --build-arg BOX_BASE=localhost/outfitter/workshop-box:dev \
  -t localhost/outfitter/workshop-box:workspace .
podman run --rm -p 8787:8787 -e BOX_WORKSPACE=1 \
  -v /absolute/private/repo:/in/repo:ro \
  -v /absolute/private/requests:/in/requests:ro \
  -v /absolute/private/results:/out \
  localhost/outfitter/workshop-box:workspace
```

Use the shared box's model-provider environment settings. On rootless Podman,
prepare private mount ownership for the image's `node` user; never recursively
chown a working repository or a hardlinked clone. Use `git clone --no-hardlinks`
for disposable input copies. `BOX_EXIT_WHEN_DONE=1` ends an eval after its input
requests; otherwise the coordinator keeps consuming queued UI/MCP requests.

Each private request JSON contains `title`, `message` and `workspace`:

```json
{
  "title": "Field instrument mounting frame",
  "message": "Build the committed assembly and report the actual checks.",
  "workspace": {
    "sourceDir": "hardware/frame",
    "sourceCommit": "0000000000000000000000000000000000000000",
    "parameters": {}
  }
}
```

Replace the example SHA with a real committed revision. Project source owns
`workspace.json`, optional `configure` command, OpenSCAD targets and assembly
metadata. The runner is `python3 /opt/workshop/build.py SOURCE_DIR OUTPUT_DIR
--parameters '{}'` inside the container. It archives source, compiles meshes,
checks solids and project-supplied interference tests, and writes `manifest.json`.
Customer models and eval inputs stay in customer repositories/private mounts.
Unmeasured physical properties stay explicitly unverified. Animation and
Kubernetes activation require subsequent work; this local harness proves neither.
