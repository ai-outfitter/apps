# Project digest eval

Grades the daily digest's summary (`project-digest` workflow, `src/server/digests.ts`) on real Planning data. It takes two Planning exports of the same installation from different days. The older export stands in for the previous digest and the newer one for "now". Each project with changes becomes one case. The production diff builds its changes, and the production instructions and schema are sent to a model.

Every answer gets these deterministic checks:

- **contract**: the headline and summary fit the schema.
- **no-invented-issues**: every quoted title is an issue the project had in either export.
- **leads-with-shipped**: when something shipped, it is named in the headline or first sentence.
- **covers-changes**: at least half (at most five) of the shipped, started and reopened issues are named.
- **calls-out-setbacks**: reopened or removed work is mentioned.

`--judge` adds an LLM verdict (grounded, shippedFirst, prioritiesClear, concise; 1 to 5 each).

## Run

Exports are private production data, so keep them and the reports outside the checkout. The runner refuses an `--out` inside it. Both export formats work: `outfitter-planning-local-v1` (app snapshots) and the production refresh's entity records. Pass when each export was taken. Otherwise its newest record time is used.

```sh
OPENAI_API_KEY=... node --import tsx apps/planning/evals/project-digest/run.ts \
  --older <private>/outfitter-2026-10-29.json --older-at 2026-10-29T19:54:59Z \
  --newer <private>/outfitter-2026-11-05.json --newer-at 2026-11-06T04:34:58Z \
  --out <private>/digest-eval/<new run> --judge
```

Settings:

- `DIGEST_EVAL_BASE_URL` sets any OpenAI-compatible endpoint (default: OpenAI).
- `DIGEST_EVAL_API_KEY` sets the key (default: `OPENAI_API_KEY`).
- `DIGEST_EVAL_MODEL` and `DIGEST_EVAL_JUDGE_MODEL` pick the models.
- `--dry` builds the cases without calling a model.

Each run writes `report.json` and `report.md` with the cases, answers, checks, judge verdicts and token usage.

`fixtures/` holds a synthetic pair that covers every kind of change. `tests/digest-eval.unit.test.ts` runs the cases and the grader on it with no model.

## Limits

- An export is a point in time, so a case sees only the net change between two exports. An issue that started and finished in between shows as shipped.
- Exports hold no delivery submissions, so those counts are zero.
- The grader matches titles by their words. A paraphrase that drops most of a title's words counts as not named.
