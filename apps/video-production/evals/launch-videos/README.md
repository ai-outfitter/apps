# Launch-video evals

The member asks an agent to plan launch videos, each a storyboard of four shots,
and save them to Onto. Storyboards and shots are a new kind of record, so the
batch should bring types for them instead of Documents. The reference answer is
this app's ontology (`src/server/onto.ts`). Names may differ; the shape may not:

- a storyboard type;
- a shot type with an order property and a duration property;
- a typed relationship from shot to storyboard (by its endpoints, or by the
  relationships the run staged).

The same request runs on two separate Ontos, each its own organization:

| Eval | Seed | Products |
| --- | --- | --- |
| `launch-videos-sunny` | `seeds/sunny.json` | SNY-1, Sunny microgreen growing system |
| `launch-videos-outfitter` | `seeds/outfitter.json` | Onto, Planning |

`lib/checks.ts` holds the shared checks: a batch in the organization's Onto, the
reference shape, at least eight records of a new type (no shots as Documents),
order and duration as properties not title text, every new record reaching the
root, Onto's review flagging the type, no extra anchors, and a judge comparing the
proposal with the reference. `lib/analysis.ts` reads the run's Onto tables;
`tests/launch-video-eval.unit.test.ts` runs it on synthetic tables with no model.
Each run prints `PROPOSED TYPES`, `REFERENCE` and `SHAPE` lines, so the two Ontos
can be read side by side.

## Run

The platform keeps the runner: the `outfitter-pi` agent in webapp
`evals/outfitter/lib/` starts a disposable Outfitter from the fixture's
`checkpoint.json` (base, seed, profile), runs the agent against its MCP server,
waits for Onto's reviews and runs `EVAL.ts` with `OUTFITTER_EVAL_RUN` set to the
run file (`lib/run.ts` reads it). This directory mirrors the runner's layout
(`evals/`, `seeds/`, `profiles/`, `experiments/`). Luna acts and judges
(`OPENAI_API_KEY`).

Not run from here yet: the runner still reads seeds and profiles from its own
`evals/outfitter/` directory, so it must first accept a suite directory (resolve
`seeds/` and `profiles/` beside the fixture's `evals/`). Until then the checks type-check (`npx tsc --noEmit -p apps/video-production`)
and the grader's unit tests run with the app's tests. The last baseline, from the
platform before the move (webapp#904, 2026-11-10, Luna, older checks): 0 of 3
runs passed on each Onto, and no run proposed a type.
