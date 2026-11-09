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
passed. The PR head, rebuilt from the implement session, passes all six
`EVAL.ts` checks. My own reference implementation also passes all six.

Both reviews asked for changes for one reason: the PR's Demo section said
"Screenshots pending". The box has no Chrome or CDP endpoint, so no agent
could capture or publish screenshots. Repair then could not read the review's
findings either, because `gh api .../pulls/<n>/reviews` and `gh pr checks` are
unsupported by the workspace's Forgejo `gh` shim. Repair and land made no
change, and the run ended `changes_requested`. subtract-helper never hit this:
it changes no UI, so no demo is required.

### What blocks a UI app from landing in the box

1. **No browser in the box image.** The review policy requires demo
   screenshots for UI changes, so every app or UI request ends
   `changes_requested`. Fix: add Chromium to the box image, as the workspace
   image provides it in production, or have the box configure a policy
   without the demo gate and say so in the result.
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
