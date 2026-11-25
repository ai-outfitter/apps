# Discovery replay experiments

The Vercel Agent Eval experiment is defined in `baseline.ts.template`. The grader in `EVAL.ts` checks evidence and relationship endpoints and asks the judge to assess organization attribution. To materialize a runnable experiment from an exported workflow session, run this from the repository root:

```sh
node apps/forerunner/evals/workflow-sessions/create.mjs SESSION.json OUTPUT_DIRECTORY
```

Use an output directory outside the repository. The generator copies the experiment into `experiments/baseline.ts` and the captured session and grader into `evals/captured-run/`. Install dependencies there, set `WORKFLOW_EVAL_JUDGE_MODEL`, and run `npm run eval -- baseline`. Keep captured mail and transcripts in the private experiment directory. For a paired comparison, generate a project from each revision using the same session and pin the same inference and judge models.
