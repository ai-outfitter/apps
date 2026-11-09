# Software Foundry box experiments

Each experiment runs one or more box evals (`../evals/<name>`) on one model and
is recorded here, so runs on different models and dates stay comparable.

| Path | What it holds |
| --- | --- |
| `foundry-box.ts` | The Agent Eval experiment config: agent, runs, default timeout. |
| `models/*.env.example` | Model settings for Luna and the DGX Spark. Copy one to `models/<name>.env` (ignored). |
| `runs/README.md` | Every recorded run, newest first. The harness rewrites it after each run. |
| `runs/<run>/run.json` | The run: model, image, checkout, box result, grade, metrics per step, kept volume and notes. |
| `runs/<run>/eval.txt`, `result.json` | The grader's output and the box's run-result (issue, PR, checks, review, release). |

The grade is `EVAL.ts` on the default branch the box left. A run that didn't
land is graded on the unchanged fixture, so only its "unchanged" checks pass.

## Running an experiment

Build the box image first (`box/README.md`, "Image and supervisor"). Then
prepare the fixtures that vendor packages, and run the evals:

```sh
node apps/software-foundry/box/evals/scripts/new-astro-app.mjs
BOX_CLI=podman BOX_MODEL_ENV=apps/software-foundry/box/evals/experiments/models/luna.env \
  node --import tsx apps/software-foundry/box/evals/run.ts new-astro-app
```

| Setting | Use |
| --- | --- |
| `BOX_IMAGE` | Image to run; `outfitter/software-foundry-box:dev` by default. |
| `BOX_TIMEOUT` | Seconds per run. Luna needs about 1,800; the Spark about 10,800 (one run took 2 h 11 min). |
| `BOX_PORT`, `BOX_FORGEJO_PORT` | Host ports for the platform (8787) and Forgejo (3300). To run two boxes side by side, give the second others. Links a run writes name 8787 and 3300. |
| `BOX_KEEP=0` | Remove the box's state when the run ends, instead of keeping its volume. |

A Spark run outlives most shells' time limits. Start it detached, for example
`setsid nohup node --import tsx … > spark.log 2>&1 &`, and read its record
when it finishes. Add what the run taught to `run.json` as `notes`, and
summarize experiments worth keeping in `../FINDINGS.md`.

## Inspecting a run afterwards

Each run keeps the box's `/box` (Forgejo, RustFS, the platform's databases,
workspaces) in a named volume. Its out folder (results, agent sessions, repo
bundle, release) and the box log are kept in the ignored
`../results/runs/<run>`.

```sh
export BOX_CLI=podman                  # as the evals used; docker by default
node box/runs.mjs list                 # kept runs, newest first
node box/runs.mjs open <volume>        # Forgejo on :3300, the platform on :8787, as the run left them
node box/runs.mjs rm <volume> | --all  # clean up
```

`open` starts the box with `BOX_REOPEN=1`: no repository import, no requests,
no workflow ticks and no workspaces. Ctrl-C stops it and keeps the volume. Sign in to Forgejo as
`box-admin`. The password is in `/box/secrets/forgejo-box-admin-password`
inside the container: `podman exec <volume>-open cat …`. The platform answers
only when published on 8787, its own origin; Forgejo works on any port
(`--forgejo-port`).
