# Foundry box

The Software Foundry as one sealed container: a repository and a folder of
feature or bug requests go in, and run results, the final git history, release
artifacts and an evidence bundle come out. Evals drive it with
`@vercel/agent-eval`, and every workflow step runs the pi coding agent against
Luna or the DGX Spark. Design: see the "Software Foundry black box" design doc.

This folder holds the box's JSON contract so far:

| Schema | What it describes |
| --- | --- |
| `schemas/work-request.schema.json` | One feature or bug request (`/in/requests/*.json`) |
| `schemas/run-result.schema.json` | What happened to it (`/out/results/<requestId>.json`) |
| `schemas/pull-request.schema.json` | The pull request the Foundry opened; its body is rendered from this |
| `schemas/evidence-bundle.schema.json` | A release's build identity, checks and proof per acceptance criterion |

The schemas are generated from `src/box/contract.ts`; after changing it run
`node --import tsx scripts/box-schemas.ts`. `tests/box-contract.unit.test.ts`
validates the fixtures in `fixtures/` and fails when a committed schema is stale.

Evidence and artifacts are addressed as `s3://<bucket>/<key>` in the box's
RustFS, always with a SHA-256 and the commit they were produced from.

## The box itself

The runnable box lives in `box` (shared harness, image, box-kube,
Agent Eval agent). The Foundry's side is here:

- `driver.mjs`: what the box does once the platform is up (configure the
  Foundry for the box repository, file requests, write results, release).
- `intake.mjs`, `results.mjs`, `release.mjs`: request intake, run-result
  documents and the release with its evidence bundle; tests in
  `tests/box-*.unit.test.ts`.
- `../agent-evals/`: the Agent Eval project (`evals/`, one experiment per model
  in `experiments/`, `run.ts`). Run
  `node apps/software-foundry/agent-evals/scripts/new-astro-app.mjs` before the
  `new-astro-app` eval; it vendors `packages/` and `apps/hr` into the fixture.
  Results so far: `agent-evals/FINDINGS.md`.

```sh
docker build --build-context webapp=../webapp --build-arg BOX_APP=software-foundry \
  -f box/Dockerfile -t outfitter/software-foundry-box:dev .
BOX_CLI=podman node --import tsx apps/software-foundry/agent-evals/run.ts luna subtract-helper
```
