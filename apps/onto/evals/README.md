# Onto submission comparison

Run from `apps/onto` after installing the workspace dependencies.

```sh
node --import tsx scripts/prepare-tests.ts
node --import tsx --test tests/submission-pair.integration.test.ts
node --import tsx evals/submission-agent.ts baseline
node --import tsx evals/submission-agent.ts candidate
```

Each arm starts an initialized disposable installation. The deterministic comparison dispatches the published GraphQL documents via the same actions as MCP. It verifies create, replay, unauthorized review, member approval of one ref, correction of another, replay, stale rejection and persisted state including both snapshots. It measures document executions. Discovery is counted separately in the agent run.

The bounded run requires an authenticated local Codex CLI with access to Sol. It gives both arms the same task, evidence, model, ten-execution budget and three-minute deadline. The CLI discovers and executes documents through a loopback endpoint. A final read by the grader checks the saved proposal and evidence. The grader requires two successful executions of the same submission and a later successful agent read identifying the same batch and version. The baseline discovers the parent commit’s published catalog. Both arms use the current disposable worker.

On November 25, 2026, the deterministic journey used 12 baseline executions and 10 candidate executions. Create and its lost-response replay each fell from two executions to one. Both arms preserved the original decision and history. Earlier bounded results used a weaker grader and do not establish successful replay or independent read under these checks.

The corrected grader subsequently passed on the workstation against commit `116ab75` in both Sol arms. Each arm executed five public documents. Baseline made five discovery reads and candidate made four. Both accepted submissions on calls 3 and 4 with identical receipts, then independently verified the single persisted version on call 5. These two bounded runs establish replay correctness for this fixture. They showed no reduction in document executions.
