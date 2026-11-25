# Forerunner graph definition quality

Run a paired [Vercel Agent Eval](https://github.com/vercel-labs/agent-eval) experiment for [#266](https://github.com/ai-outfitter/apps/issues/266). The public fixture represents a synthetic discovery batch. The model receives the same task, evidence, graph lookup and limits in both arms. Only the graph type context changes. The baseline uses published type names. The candidate uses the Onto and Forerunner owner namespaces from the graph refactor in [#267](https://github.com/ai-outfitter/apps/pull/267). Both use the same scoped descriptions and directed endpoints, with synthetic IDs for installed records.

## Run the pair

With Node 24 and the repository's locked dependencies installed, point the runner at your trusted OpenAI-compatible Spark endpoint. It needs `/models`, `/chat/completions`, function calls, and JSON object mode. Set `EVAL_API_KEY` if your endpoint requires authentication.

```sh
EVAL_BASE_URL=http://your-spark:8888/v1 node apps/forerunner/evals/graph-definition-quality/run.mjs
node --test apps/forerunner/evals/graph-definition-quality/fixture.test.mjs box/tests/read-only-eval.test.ts
npm test
actionlint
```

The shared adapter in `box/eval` registers the two custom agents with Agent Eval and runs both experiments sequentially. For each fixture, the adapter reads public inputs, offers only an in-memory lookup, and passes the final proposal to a separate scorer. To reuse it, supply a project with `experiments/baseline.ts` and `experiments/candidate.ts`, fixtures under `evals/`, and a `prepare(arm, fixture, prompt)` function like [fixture.mjs](fixture.mjs). Keep task evidence, model, tools, and limits fixed when comparing a change.

Each invocation writes native Agent Eval results and a `pair.json` under a new directory in `results/`. You can change the parent directory with `EVAL_RESULTS_DIR`. The pair receipt records exact initial messages, input and rubric hashes, tool queries and results, model response IDs and server fingerprint, token usage, latency, final proposals, and grader output. Wall time covers the model/tool loop and local scoring. Output tokens sum provider-reported completion tokens across all turns, including tool arguments. Tool calls count requests emitted by the model.

## Refresh the authored schema context

The default run uses the checked-in `schema-authored.json`. To regenerate it from a clean checkout of the candidate revision, install its locked dependencies and run its graph composer. Then run the projector from this eval checkout.

```sh
npm --prefix /path/to/candidate run graph:compose
node apps/forerunner/evals/graph-definition-quality/project-schema.mjs /path/to/candidate <candidate-sha> > /tmp/schema-authored.json
```

The projector checks the generated graph for staleness and matches scoped types by stable ID. It verifies the full directed endpoint sets against the baseline before projecting the directions relevant to this case. It records both source commits and the generated standard-types SHA-256. Use `EVAL_SCHEMA=/tmp/schema-authored.json` to run with a regenerated projection, or point `EVAL_SCHEMA` to the original `evals/connected-discovery/schema.json` to replay the first instruction setup.

## Spark measurements

The authored pair uses #267's committed app contributions at `c6f740d71743536b28d76911996ec63e5012e227`. Its [schema projection](evals/connected-discovery/schema-authored.json) records the generated type artifact hash. Both the projection and generated type artifact match the earlier [local snapshot run](https://github.com/ai-outfitter/apps/blob/b6990890c2a28eb4c30ca42538ff50497128e268/apps/forerunner/evals/graph-definition-quality/receipts/spark-authored-pair.json). The model saw `forerunner:` for the discovery-owned types and `onto:` for the foundation types. The baseline messages match the earlier instruction pair byte for byte.

Both pairs ran on 2026-11-25 with GLM-5.3-Flash-EXL3, snapshot `25a44fdbf16862a46b7cc9921142c6c81350af2f`, vLLM fingerprint `vllm-0.1.dev20051+g487ecf187-tp2-06793def`, and Agent Eval 2.6.0. Each arm had 75 seconds, up to five model calls, four lookup calls, and 1,000 completion tokens per model call. Temperature was 0 and the requested seed was 266. The service handled both runs on the same advertised model and reported the same fingerprint.

| Arm | Grounding | Canonical reuse | Directed relationships | Decision evidence | Lookup calls | Model calls | Wall time | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Published names, authored pair | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 17.888 s | 4,048 | 589 |
| Authored Onto and Forerunner namespaces | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 18.361 s | 4,348 | 588 |
| Published names, initial pair | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 16.950 s | 4,048 | 455 |
| Initial `onto:` instruction projection | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 18.013 s | 4,268 | 583 |

Both reused the verified account holder and the registered organization, including reuse across operator and publisher roles. Both submitted all four supported directed relationships. The frozen rubric requires primary citations for the product node and marks both arms down for also citing the marketing email. The email mentions the product, so that miss measures strict citation selection. Neither arm used marketing to justify a use or developer edge.

A manual review against the synthetic evidence checked both free-text reasons in each arm, separately from the deterministic scorer. Both proposals explained that a successful sign-in and an invitation establish no actual activity. Both identified the operator terms as evidence for operation and identified the missing independent developer attribution. The automated decision score checks the chosen action and cited evidence IDs, plus the presence of a reason. The reviewer could see the arm labels.

The [authored pair receipt](receipts/spark-authored-pair.json) and [initial instruction receipt](receipts/spark-instruction-pair.json) contain the exact prompts, responses and scores. The earlier [runner bring-up receipt](receipts/spark-runner-bringup.json) shows the same model and budget with two empty responses at the last turn. The harness then added a shared final-turn instruction and JSON object mode when tools were exhausted. The task, type context, evidence, and rubric hashes match the initial scored pair.

One case per treatment and the baseline's own token and timing variation limit the conclusion. Latency includes local serving conditions and the fixed baseline-first order. The experiment covers proposal quality under the projected graph context. Production prompt wiring, installation persistence, publication and end-to-end graph writes require separate evidence.
