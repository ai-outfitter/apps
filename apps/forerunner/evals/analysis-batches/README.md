# Oversized Gmail analysis regression

A synthetic, deterministic regression for the November 5 Gmail failure: one message worked; 40 messages selected over 30 days produced `Step data too large` before any provider request. The inference host measures `JSON.stringify(data).length` against 65,536 JavaScript string characters, not tokens or UTF-8 bytes.

This Agent Eval task isolates the input-packing policy that production `semanticProposal` now calls. Its starting function extracts the former single-request behavior from `apps/forerunner/src/server/semantic-discovery.ts` at `5563bf1d005897a46daa40547c6c083b62880e72` (source SHA-256 `b572aff5d5fc2237b1213aebc88fcc1cff6efa2006b5dedb93f90f7313616627`). It is deliberately a small code-changing task, not a model-quality benchmark. No personal email is included. The grader enforces complete serialized input bounds, evidence conservation, unchanged context, and explicit overflow errors.

From the checkout root:

```sh
# Deterministic grader against the old behavior: expected nonzero exit, 3 failed / 1 passed.
node apps/forerunner/evals/analysis-batches/check.mjs --baseline
# The same grader against the actual production helper: 4 passed.
node apps/forerunner/evals/analysis-batches/check.mjs
# Discover the coding-agent task without launching an agent or sandbox.
npm run evals:agent -- --project apps/forerunner/evals/analysis-batches codex --dry
```

To benchmark a coding agent later, omit `--dry`; that needs Docker and agent credentials. No coding-agent trial or live inference trial was performed for this change (zero agent runs). The local verification uses one deterministic baseline run and one production run. The existing default experiment uses the coding CLI's native model and does not evaluate smaller inference models.

Production integration is covered separately by the app's semantic-discovery unit tests and discovery-range integration test: 40 full excerpts cross the former host limit; each new request fits; citation enums are scoped to the batch; repeated model keys remain isolated; persisted history retains all input and the combined answer; a later provider failure keeps the previous preview and creates no partial replacement. Those tests exercise real app code with synthetic connector/model responses and an in-memory database. They do not establish Gmail OAuth or live model quality.

The implementation uses sequential batches with a 56 KiB serialized-character budget and the existing workflow model/settings. It leaves the host's 64 KiB ceiling and the source read cap of 40 records unchanged. A 30-day selection can still have unread mail (`more: true`); resumable backfills and model-routing experiments remain separate work.
