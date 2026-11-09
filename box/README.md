# App boxes

A box is one official app sealed in a container: a repository and a folder of
JSON requests go in; results, the final git history, releases and evidence
come out. It runs the real platform (the `ai-outfitter/webapp` checkout with
real app workers and the workspace gateway) with the app installed, and local
stand-ins for the services the platform normally reaches: Forgejo for GitHub,
RustFS for object storage, and box-kube for the Kubernetes workspace operator.

This package is the shared harness. Each app that has a box keeps its side in
`apps/<app>/box/`:

| File | What it does |
| --- | --- |
| `driver.mjs` | Exports `app` (the app slug), an optional `title` and `platformModel`, and `run(box)`, which the supervisor calls once the platform is up to file the requests, watch their runs, write `/out/results` and release. It calls `box.finish()` when everything is written. |
| `schemas/` | The app's request and result JSON contract. |
| `evals/` | Agent Eval fixtures and the runner, using `@ai-outfitter/box/eval`. |

Boxes today:

- Software Foundry (`apps/software-foundry/box`): feature and bug requests
  become Forgejo issues that the Foundry takes to merged PRs.
- Workshop (`apps/workshop/box`): design requests go to Workshop's design
  agent, and the box commits each design's project, STEP, STL and BOM.

A driver that sets `platformModel = true` (Workshop, whose design agent calls
the model from the platform) has the model settings passed to the platform too.
Shared helpers for drivers (git, hashes, release versions) are in `lib.mjs`.

What stays in the webapp: the platform changes a box needs (the Forgejo-backed
organization connection, the gateway's Forgejo checks, the workspace `gh`
shim, the local-organizations `embed` hook, and `scripts/local-dev/box-platform.ts`,
which seeds the box organization with the box app installed). The image runs
them from the webapp checkout.

## box-kube

`box-kube.mjs` serves the slice of the Kubernetes API the workspace gateway
uses (namespaces, resource quotas, secrets, pods and their resize, `Workspace`
resources, token reviews, OIDC discovery) and runs each awake `Workspace` as a
local `workspace/runtime` process with pi inside, instead of a Pod started by
the workspace operator. It reports status the way the operator does (`Ready`
reason, `podName`, `computeGeneration`, `observedGeneration`), stops a runtime
when its workspace sleeps, and reports `Interrupted` when one exits.

Point the gateway at it:

```sh
KUBERNETES_API_URL=http://127.0.0.1:7070
KUBERNETES_TOKEN_FILE=/box/kube-token   # any non-empty file; box-kube ignores it
WORKSPACE_RUNTIME_ORIGIN='http://127.0.0.1:7070/runtime/{namespace}/{id}'
```

box-kube settings: `BOX_KUBE_PORT` (7070), `BOX_KUBE_STATE` (JSON file to
persist objects), `BOX_WORKSPACES_DIR` (`/box/workspaces`),
`BOX_RUNTIME_SCRIPT` (`/opt/workspace/server.mjs`), `BOX_GATEWAY_URL`
(`http://127.0.0.1:4040`, used for each runtime's `INFERENCE_BASE_URL`) and
`AI_MODEL`.

It listens on loopback only, has no auth, watches or selectors, and answers
token reviews as unauthenticated, so identity-based inference is not offered
in the box; runtimes use their workspace token. Tests:
`tests/box-kube.test.ts` (`npm test` here).

## Image and supervisor

`Dockerfile` builds one image with Forgejo (copied from the pinned Forgejo
image), RustFS, the webapp checkout with its built app packages, the workspace
gateway, box-kube and the workspace runtime with pi. Released app packages are
fetched and verified at build time only; the box app's operational package is
built from this checkout and replaces its released one. Build from the root of
this repository with a webapp checkout as the `webapp` build context:

```sh
docker build --build-context webapp=../webapp --build-arg BOX_APP=software-foundry \
  -f box/Dockerfile -t outfitter/software-foundry-box:dev .
```

The harness is copied to `/app/.box/box` and the app to
`/app/.box/apps/<app>`, so both resolve the checkout's modules.

`supervisor.mjs` is the entrypoint. It:

1. starts RustFS on `127.0.0.1:9000` and creates the `foundry` (attachments)
   and `artifacts` (workflow artifacts) buckets;
2. writes a sealed Forgejo config (SQLite, loopback, offline, no
   registration), starts Forgejo on `127.0.0.1:3300`, and creates the
   `box-admin`, `outfitter` (platform bot) and `reviewer` users and the bot's
   access token;
3. creates the `box` organization and `box/<name>` repository and pushes every
   branch and tag of `/in/repo` into it (the mount is never changed);
4. starts box-kube, the gateway (`WORKSPACE_FORGEJO_ORIGIN`) and the platform
   (the webapp's `scripts/local-dev/box-platform.ts`, with `BOX_APPS` set to
   the driver's app) on the inspection port (`8787`);
5. calls the driver's `run(box)`, ticks workflows every few seconds, and
   writes `/out/box.json`.

The driver's `box` has the repository and default branch, `forgejo(method,
path, body)` (Forgejo's API as the platform bot), `operator(input)` (the app's
operator workflow requests), `store(key, bytes, type)` (RustFS),
`databases.platform` and `databases.gateway` (SQLite files to read run state),
`port` (the platform's port on loopback),
the model in use, `out`, `log` and `finish(error?)`, which writes
`/out/repo.bundle` and, with `BOX_EXIT_WHEN_DONE=1`, stops the box.

Generated secrets stay in `/box/secrets` inside the container. `BOX_HOLD=1`
keeps the services up after a setup failure; `BOX_DEBUG_HOST=1` logs refused
workflow host calls, node dispatch errors and gateway errors.

## Platform

The production Node build cannot dispatch apps, so the webapp's
`scripts/local-dev/box-platform.ts` runs the local-organizations loader (the one
`dev-local` uses) with one `box` organization that has the box app installed. Sign in at
`http://outfitter.localhost:8787` as `local@example.test` / `local-orgs-only`.

The organization's repository connection is a real Forgejo connection
(provider `forgejo`), preset at startup as an admin would connect it in
organization settings: the box's Forgejo origin, the `outfitter` bot's id and
encrypted token, and the box repository. The supervisor, as the operator, lists
that origin in `FORGEJO_ALLOWED_ORIGINS`, the only way an origin on this machine
(`http://127.0.0.1:3300`) is accepted. Software Foundry declares
`connector.forgejo.issues.*`, so the platform answers its repository list,
metadata and issue reads, `issues.create` and `issues.comment`, subscription
coverage and binding approval from that connection
(`src/lib/forgejo-authority.ts` in the webapp), and binds workspaces to the
repository with its bot. The gateway serves the Forgejo named by
`WORKSPACE_FORGEJO_ORIGIN` and refuses a task for any other forge; workspaces
push with git and use a `gh`-compatible shim
(`workspace/runtime/forgejo-cli.mjs`) against it.

## Software Foundry: requests, results and releases

`apps/software-foundry/box/driver.mjs` configures Foundry's workspace workflow
for the repository (checks run in a workspace, since the box has no Actions). Each `/in/requests/*.json` work request (`ai-outfitter/apps`:
`apps/software-foundry/box/schemas/work-request.schema.json`) becomes one
Forgejo issue, marked with its request id, and Foundry's operator `start`
launches its issue-to-merge workflow (`intake.mjs`). Rerunning finds the same
issue and run.

When a run ends, `results.mjs` writes `/out/results/<requestId>.json`, a
`run-result` document read from the run's status, each node's reported
outputs and the issue, PR, statuses and reviews on Forgejo. When the landed
requests ask for a release (`release.trigger`), `release.mjs` tags the next
version, stores a source archive, the git history and an evidence bundle
(`evidence-bundle.schema.json`) in RustFS under `releases/<tag>/`, publishes a
Forgejo release that links the bundle, and copies them to
`/out/release/<tag>`. The final history of every branch and tag is
`/out/repo.bundle`. With `BOX_EXIT_WHEN_DONE=1` the box stops once these are
written. These modules live in `apps/software-foundry/box/`, with their tests in
`apps/software-foundry/tests/box-*.unit.test.ts`.

## Agent Eval

`eval/agent.ts` (`@ai-outfitter/box/eval`) runs a box under Vercel Agent Eval.
Its agent turns each fixture into a git repository and a request (the
fixture's `request.json`, or one the app makes from `PROMPT.md`), runs the
image to completion with the platform published on `BOX_PORT` (8787) for
watching, and grades the default branch the box left with the fixture's
`EVAL.ts`. For the Software Foundry:

```sh
BOX_CLI=podman BOX_MODEL_ENV=model.env node --import tsx apps/software-foundry/box/evals/run.ts subtract-helper
```

`BOX_TIMEOUT` sets each run's limit in seconds (the experiment's default is
1800). A Foundry run on the DGX Spark takes longer than on Luna; give it 4800.
Each run's time and model use (wall and model seconds, model calls, tokens in
and out, output tokens per second) is printed after the results and saved in
`results/<box>-metrics-<time>.json`, so runs on different models can be compared.

### Kept runs and records

Each run keeps the box's `/box` (Forgejo, RustFS, the platform's databases,
workspaces) in a named volume labelled `outfitter.box.run`. `podman run --rm`
removes the container, not the volume. The run's out folder and box log go to
the app's ignored `evals/results/runs/<run>`, and a record (`run.json`, the
grader's `eval.txt`, the box's `result.json`) to the committed
`evals/experiments/runs/<run>`, with an index (`eval/experiments.ts`). A box
that never starts (a taken port, say) is neither kept nor recorded. Set
`BOX_KEEP=0` to drop the state after a run.

`box/runs.mjs` lists kept runs, reopens one for inspection and removes them:

```sh
BOX_CLI=podman node box/runs.mjs list   # BOX_CLI as the evals used; docker by default
node box/runs.mjs open <volume> [--port 8787] [--forgejo-port 3300]
node box/runs.mjs rm <volume>... | --all
```

`open` starts the image with `BOX_REOPEN=1`. The supervisor brings Forgejo,
RustFS, the gateway and the platform up on the kept state, but imports
nothing, files no requests, runs no workflow ticks and starts no workspaces
(box-kube stays down), so the box stays as the run left it.

### Geometry scoring

`eval/geometry.ts` (`@ai-outfitter/box/geometry`) scores CAD output against a
reference part the way text-to-CAD benchmarks do (CADPrompt, Text2CAD,
CAD-Recode): whether the code runs (an OpenSCAD `.scad` file renders, or the
STL exists), whether the mesh is a valid, watertight solid (closed, manifold,
consistently wound, positive volume), then volume IoU, Chamfer and Hausdorff
distance against the reference. Prompts give sizes in millimetres, so parts
keep their scale; both are centred and the candidate is tried in each of the
24 axis-aligned orientations. `chamferMm` and `hausdorffMm` measure sampled
points to the other surface in millimetres; `chamferUnit` is the benchmarks'
point-to-point form (unit box, squared, x 10^3).

A fixture's `reference/` folder is hidden from the box and copied beside
`EVAL.ts` for grading, so `EVAL.ts` can call `scoreGeometry` on an exported STL
and `recordScore` the result. Recorded scores go into the metrics JSON and add
IoU, Chamfer and watertight columns to the metrics table. Outside an eval:

```sh
node --import tsx box/eval/score.ts <candidate.stl|.scad> <reference.stl|.scad>
node --import tsx box/eval/score.ts render apps/workshop/box/evals/evals/*/reference/model.scad
```

`render` (re)writes each reference's STL with OpenSCAD (`openscad`, or
`OPENSCAD=<path>`); the STLs are committed, so grading needs no OpenSCAD.

## Agent sessions

Every agent a request used is recorded as a pi session (`box/sessions.mjs`):
each Software Foundry node attempt (pi's own session file from its workspace)
and each Workshop design-agent turn (the platform's prompt, answer, times and
tokens, written in pi's format). A request's sessions are:

- written to `/out/sessions/<requestId>/<agent>.jsonl`, with `transcript.jsonl`
  merging all of them in time order, each message tagged with its agent;
- committed to the box repository's `outfitter/sessions` branch under
  `sessions/<requestId>/`, with Git LFS. Forgejo keeps the LFS objects in the
  `lfs` bucket of the box's RustFS; the default branch is untouched;
- named in the result's `sessions` field (branch, commit, and each file's hash).

The eval runner hands `transcript.jsonl` to Agent Eval as the run's transcript
(its `transcript.json` then lists every agent's messages and tool calls with
timestamps) and copies the session files to `results/<box>-sessions/`.
`repo.bundle` carries the sessions branch with LFS pointers only; the files
themselves are in `/out/sessions`.

## Models

Only the gateway, which proxies every workspace's inference, receives model
settings; the supervisor strips them from every other process. For Luna:

```sh
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
AI_MODEL=gpt-6-luna
```

Pass them with `--env-file`. The DGX Spark uses `SPARK_BASE_URL`,
`SPARK_AUTHORIZATION` and, behind Cloudflare Access, `SPARK_ACCESS_CLIENT_ID`
and `SPARK_ACCESS_CLIENT_SECRET` (the webapp's `scripts/spark/README.md`), or a full
`INFERENCE_PROVIDERS` chain. The box's only outbound traffic is to that
endpoint.

On the LAN the Spark needs no Access token:

```sh
SPARK_BASE_URL=http://192.168.1.176:8888/v1
SPARK_AUTHORIZATION=Bearer lan
AI_MODEL=GLM-5.3-Flash-EXL3
```

## Live Forgejo check

`checks/forgejo-live.mts` drives the Foundry's Forgejo adapter
(`apps/software-foundry/src/server/workspace/forgejo.ts`)
and the workspace `gh` shim against the box's running Forgejo: issue, branch
push, draft PR, ready, triage comment, commit-status check, refusal without
approval, independent approval and squash merge. Run it from a container that
shares the box's network, with an apps checkout mounted at `/apps`:

```sh
docker run --rm --network container:<box> -w /app \
  -e BOT_TOKEN="$(docker exec <box> cat /box/secrets/forgejo-bot-token)" \
  -e REVIEWER_PASSWORD="$(docker exec <box> cat /box/secrets/forgejo-reviewer-password)" \
  -v "$PWD:/apps:ro" -v "$PWD/box/checks:/live:ro" \
  --entrypoint node outfitter/software-foundry-box:dev --import tsx /live/forgejo-live.mts
```

## Still to come

- Per-criterion evidence (screenshots, logs) in RustFS, referenced from the
  PR document and the evidence bundle; criteria are now judged from the checks
  and the independent review.
- Replayed model answers for a run with no network at all.
- A Workshop box on the forge: change requests as PRs with BOM and cost diffs.
