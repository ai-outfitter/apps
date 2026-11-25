# Onto submission comparison

Run from `apps/onto` after installing the workspace dependencies.

```sh
node --import tsx scripts/prepare-tests.ts
node --import tsx --test tests/submission-pair.integration.test.ts
node --import tsx evals/submission-agent.ts baseline
node --import tsx evals/submission-agent.ts candidate
```

Each arm starts an initialized disposable installation. The deterministic comparison dispatches the published GraphQL documents via the same actions as MCP. It verifies create, replay, unauthorized review, member approval of one ref, correction of another, replay, stale rejection and persisted state including both snapshots. It measures document executions. Discovery is counted separately in the agent run.

The bounded run requires an authenticated local Codex CLI with access to Sol. It gives both arms the same task, evidence, model, ten-execution budget and three-minute deadline. The CLI discovers and executes documents through a loopback endpoint. A final read by the grader checks the saved proposal and evidence. The grader also checks for a successful repeated mutation and an independent read by the agent.

On November 25, the deterministic journey used 12 baseline executions and 10 candidate executions. Create and its lost-response replay each fell from two executions to one. Both arms preserved the original decision and history. The bounded Sol run passed for both arms with four executions each. Baseline used three discovery reads and candidate used five. Candidate sent one malformed variables envelope before successfully submitting and replaying. An earlier candidate run without an example in its published description used seven executions. One model run per configuration does not establish average savings.
