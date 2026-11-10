# Workshop eval findings

## Mini-ITX case parts on the DGX Spark (2026-11-10)

The six `case-*` evals ask a model for each part of the printed Mini-ITX case
in `examples/mini-itx-case`, one part at a time (vision tier 2). Each part is a
single design turn: one model call that returns a CAD plan, graded against the
hand-built reference with volume IoU >= 0.95 and Hausdorff <= 0.5 mm.

Setup: apps 0ba9bde2 (box image built from apps 4306582f, webapp c9ef2798).
The model was GLM-5.3-Flash-EXL3 on the Spark over the LAN (`experiments/spark.ts`).

| eval | result | wall s | tokens out | out tok/s | IoU | Hausdorff mm |
| --- | --- | --- | --- | --- | --- | --- |
| case-board | pass | 55.6 | 1931 | 35.5 | 1.000 | 0.003 |
| case-psu | fail | 54.2 | 1565 | 29.7 | 0.997 | 5.000 |
| case-cooler | pass | 12.8 | 225 | 21.0 | 0.997 | 0.000 |
| case-base | pass | 63.3 | 2339 | 37.8 | 1.000 | 0.007 |
| case-top | fail | 212.7 | 7224 | 34.4 | 1.000 | 0.985 |
| case-shell | pass | 197.5 | 6377 | 32.7 | 1.000 | 0.007 |

4 of 6 passed in 708 s. Both failures came from ambiguous prompts, not from the
model, and the prompts are now fixed:

- **case-psu:** the prompt said "rear face" without saying which end that is.
  The model put the inlet on -Y; the reference puts it on +Y, toward the back
  of the case. The 5 mm Hausdorff is the inlet's protrusion on the wrong end.
  The prompt now names the +Y end. On the re-run the model put the inlet on
  +Y but measured "left" as seen from behind, which mirrored it in X, so the
  prompt now says "3.4 mm from its -X side".
- **case-top:** the prompt put the pilot holes "3.5 mm below the plate's top
  face", and the model did exactly that. The reference (`lip_screw_z = H - wall
  - 3.5`) measures from the plate's underside, 3 mm lower. The prompt now says
  underside. On the re-run the top passed (IoU 1.000, Hausdorff 0.007 mm,
  164 s, 5609 tokens out).

The largest part, the shell, needed about 6400 output tokens and 195 s. The
top needed 7200 tokens.

### The first run, and what it fixed

The first run on the same day scored 0 of 6. Every failure was the harness,
fixed in #108 and #112:

- The fixtures had no `request.json`, so the box committed each design under a
  folder named after the prompt's title, and the grader found nothing. Board,
  power supply and cooler had designed and exported fine.
- A saved iteration's dimensions were capped at 200 mm while plans allow
  300 mm, so the 224 mm base was refused.
- The design step's 8000-token and 300 s limits stopped the top and the shell.
  They are now 16000 tokens and 840 s, and the box driver waits 900 s.
- Agent Eval starts every eval's timer at once while boxes run one at a time.
  Its overall limit now covers the whole queue, and each box keeps the
  experiment's timeout from when it starts.

### Running it

```sh
cp apps/workshop/agent-evals/.env.example apps/workshop/agent-evals/.env.spark   # fill in the Spark settings
BOX_CLI=podman node --import tsx apps/workshop/agent-evals/run.ts spark case-board case-psu case-cooler case-base case-top case-shell
```

Build the box image from a clean webapp checkout (`git worktree add`). Agent
worktrees under `webapp/.claude/worktrees` can exhaust the container storage
quota.

### Next

- Re-run case-psu with its second prompt fix.
- Run the same six on Luna (`experiments/luna.ts`) for comparison.
- Go from parts to the assembly: the full case request in
  `examples/mini-itx-case/request.json`, graded on fit and interference.
