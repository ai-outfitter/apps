# Foundry box eval findings

## new-astro-app on Luna (2026-11-08)

The `new-astro-app` fixture asks the Foundry to add a demo-mode Astro app,
Release Radar, beside `apps/hr` in a caller repository that vendors the public
SDK (`scripts/new-astro-app.mjs` fills it). `EVAL.ts` builds the demo package
and serves it in the `@ai-outfitter/app-test` Miniflare host.

| eval | model | box result | grade of the PR head | wall s | model s | calls | tokens in | tokens out |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| subtract-helper (earlier baseline) | gpt-6-luna | landed | pass | 166 | 103 | 47 | 199k | 5.8k |
| new-astro-app | gpt-6-luna | changes_requested | 6/6 | 512 | 424 | 136 | 3.05M | 18.5k |

**The code was right; the run did not land.** Implement wrote a complete app
in one pass: manifest, package, staged fixtures with `summarize`, `/` and
`/repos/[name]` with a 404, the hr middleware (health, 405, CSP, cache), a
unit test and the lockfile. Both validations, both reviews and the land step
agreed that astro check, the unit tests, the demo build and root `npm test`
passed. The box deletes its work directory, so the exact PR head could not be
graded. A tree rebuilt by replaying the implement session's writes, edits and
file-changing shell commands passes all six `EVAL.ts` checks. My own
reference implementation also passes all six. The first grade of the replayed
tree was 4/6: the request did not name `summarize`'s count field, the app
called it `mergedPullRequestCount`, and the grader was then changed to accept
any numeric field.

Both reviews asked for changes for one reason: the PR's Demo section said
"Screenshots pending". The agents found no Chrome or CDP endpoint, and the
image has no Chromium (`which chromium google-chrome` finds nothing), so no
agent could capture or publish screenshots. Repair then could not read the review's
findings either, because `gh api .../pulls/<n>/reviews` and `gh pr checks` are
unsupported by the workspace's Forgejo `gh` shim. Repair and land made no
change, and the run ended `changes_requested`. subtract-helper never hit this:
it changes no UI, so no demo is required.

### What blocks a UI app from landing in the box

1. **No browser in the box image.** The `issue-to-merge-workspace` workflow's
   implement and review instructions require desktop and mobile screenshots
   for visual changes. That rule is in the prompt text, not a setting the
   driver can turn off, so every app or UI request ends `changes_requested`.
   The runtime's `/opt/workspace/browser-mcp.mjs` already supports
   `CHROME_EXECUTABLE_PATH` or `AGENT_BROWSER_CDP_URL`. **Fixed in the image**
   (not yet re-run with this eval): `box/Dockerfile` now installs Chrome for
   Testing 154 and sets `CHROME_EXECUTABLE_PATH`, as the webapp's
   `workspace/runtime/Dockerfile` does. The runtime's
   `browser-agent-smoke.mjs` passes in the rebuilt image (pi drives Chrome
   through the MCP and takes a screenshot) once its tool list includes
   `resize_page` and `emulate`; the smoke script upstream lags `server.mjs`.
   Publishing the screenshot (`publish-image.mjs`, the gateway's
   `publish_evidence`) on the Forgejo path is still unverified.
2. **The Forgejo `gh` shim lacks review and check reads.** Repair cannot see
   *why* a review asked for changes, so the repair loop is blind on any
   repository that is not GitHub.
3. **The SDK's builder needs a client asset.** `outfitter-app-build` throws
   "Incomplete app build" when an Astro app emits no client asset (for
   example, no imported stylesheet). The agent hit it nine times and spent
   most of implement's 59 calls (1.79M input tokens) on CSS packaging, trying
   a `<link>`, Google Fonts and inline `<style>` (both blocked by the CSP)
   before importing a stylesheet. My reference hit the same error. Fix: say
   so in the builder error and the SDK docs, or allow asset-free apps.

### Screenshots in the box (2026-11-08, later)

Getting a screenshot from a box agent into its Forgejo PR needed five fixes;
all but the last are in this branch:

| Gate | Symptom | Fix |
| --- | --- | --- |
| No Chrome in the image | MCP: "Chrome executable is not configured" | `box/Dockerfile` installs Chrome for Testing 154 |
| Long workspace paths | every Chrome MCP call: "Target closed" | `box-kube.mjs` gives runtimes a short `/box/w/<hash>` root; Chrome's profile sockets under `TMPDIR` broke the 108-byte Unix socket limit past ~60 characters |
| Gateway had no `WORKFLOW_NODE_URL` | `publish_evidence` → 503 | supervisor sets it (loopback HTTP, so `NODE_ENV=test` for the gateway) |
| Foundry `publish` took only `issue-to-merge-actions-ci` | 404 for box runs | accepts `issue-to-merge-workspace` too |
| Demo check counted only HTTPS images | box PRs always "Demo needs attention" | HTTP allowed for `localhost`, `*.localhost` and `127.0.0.1` |

Forgejo now keeps attachments, avatars, archives and packages in RustFS
(`forgejo` bucket; LFS stays in `lfs`), and evals publish Forgejo on
`127.0.0.1:3300` so a running box's PRs can be opened from the host.

Runs on Luna with these fixes:

- Before the short root: **landed**, but with no screenshots. Every Chrome
  call failed; the first review asked for screenshots, and review-final
  approved anyway as "an evidence gap, not a defect". The demo gate is not
  consistent between the two reviews.
- With the short root: implement drove Chrome (31 MCP calls: `astro dev`,
  desktop and mobile `take_screenshot` into `test-results/`), then ran out
  of its tool limit before publishing. `astro dev` injects inline `<style>`
  tags, and the hr-style middleware's `style-src 'self'` CSP blocks them, so
  the dev page renders unstyled; the agent kept chasing CSS that the built
  package serves correctly. Any Outfitter Astro app with that middleware
  hits this. Open: screenshot the built demo package (the app-test
  Miniflare host or `astro preview`) instead of `astro dev`, through the
  Foundry's implement guidance or an SDK preview command, or relax the CSP
  only in dev.

### Follow-ups from review

- The gateway runs with `NODE_ENV=test` only to accept a loopback HTTP
  `WORKFLOW_NODE_URL`; that flag also relaxes its other loopback URL checks.
  A dedicated gateway opt-in in webapp (`internalUrl`) would keep the box on
  production URL validation.
- `workspace/runtime/server.mjs` always sets `TMPDIR = <WORKSPACE_ROOT>/tmp`.
  Accepting a caller's `TMPDIR` would let the box drop its short links.
- The box copies webapp's Chrome install line for line; a shared install
  script in webapp would keep the version and libraries in one place.
- `landing-recovery.ts` still recovers only `issue-to-merge-actions-ci` runs,
  so a box run that fails final review gets no landing recovery.

### Harness notes

- Agent Eval only discovers a fixture that has `PROMPT.md`, even when
  `request.json` is the request.
- The box reaches the npm registry; `npm ci` with Astro, workerd and
  Miniflare works inside. The Dockerfile's "no network except the model"
  is not enforced by `box/eval/agent.ts`.
- A failed run leaves nothing to grade: the work directory and its
  `repo.bundle` are deleted, and `EVAL.ts` grades `main`. Grading the PR head
  needed a replay of the implement session. Keeping the bundle, or grading the
  PR head as well when a run does not land, would separate "the code is wrong"
  from "the gate refused it".
- Nested `node --test` inherits `NODE_TEST_CONTEXT` and silently skips the
  inner test files; the fixture's root test strips it.

### Running it

```sh
node apps/software-foundry/box/evals/scripts/new-astro-app.mjs   # fills the fixture first
BOX_CLI=podman BOX_MODEL_ENV=model.env BOX_TIMEOUT=3600 \
  node --import tsx apps/software-foundry/box/evals/run.ts new-astro-app
```

## Apps to build next

These are ranked by how well they fit a single Foundry run. Each one starts
demo-only, as Release Radar did, then goes operational with a package that
already exists in `packages/`.

1. **Release Radar, operational.** Swap the staged fixtures for
   `captureGithubActivity` from `connector-github` (bounded, half-open
   periods) behind `connector.github.pulls.read`. This is the smallest next
   step, and its demo already exists.
2. **Meeting Prep.** Reads upcoming events read-only with
   `connector-google-calendar` and shows a prep page for each meeting. The
   demo is a staged calendar. It fits one run.
3. **Routines board.** A front end for `workflow-recurring-task`: the
   weekday scheduled tasks, their last runs and whether the owner used the
   output. The demo fits one run. Going operational needs workflow host
   wiring, as HR's role packet has.
4. **Profile review.** Shows the work profile that
   `workflow-email-profile-onboarding` infers from a bounded Gmail sample and
   lets the member correct it. The demo is easy. The operational version
   touches Gmail data, so review it by hand.
5. **Eval scoreboard.** Reads the box's `results/*-metrics-*.json`, one row
   per run and model, compared over time. It uses only the repository's own
   data and makes the Foundry's progress visible. It fits one run.
