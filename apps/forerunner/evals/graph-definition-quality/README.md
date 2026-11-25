# Forerunner graph definition quality

Run a paired [Vercel Agent Eval](https://github.com/vercel-labs/agent-eval) experiment for [#266](https://github.com/ai-outfitter/apps/issues/266). The public fixture represents a synthetic discovery batch. The model receives the same task, evidence, graph lookup and limits in both arms. Only the graph type context changes. The baseline uses published type names. The instruction candidate adds the type owner's namespace to the same definitions and directed endpoints. This is an authored-reference task over a scoped projection of existing Onto and Forerunner instructions, with synthetic IDs for installed records.

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

## Spark measurements

Run on 2026-11-25 with GLM-5.3-Flash-EXL3, snapshot `25a44fdbf16862a46b7cc9921142c6c81350af2f`, vLLM fingerprint `vllm-0.1.dev20051+g487ecf187-tp2-06793def`, and Agent Eval 2.6.0. Each arm had 75 seconds, up to five model calls, four lookup calls, and 1,000 completion tokens per model call. Temperature was 0 and the requested seed was 266. The service handled both runs on the same advertised model and reported the same fingerprint.

| Arm | Grounding | Canonical reuse | Directed relationships | Decision evidence | Lookup calls | Model calls | Wall time | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Published names | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 16.950 s | 4,048 | 455 |
| Namespaced instruction projection | 5/6 | 3/3 | 5/5 | 3/3 | 4 | 5 | 18.013 s | 4,268 | 583 |

Both reused the verified account holder and the registered organization, including reuse across operator and publisher roles. Both submitted all four supported directed relationships. The frozen rubric requires primary citations for the product node and marks both arms down for also citing the marketing email. The email mentions the product, so that miss measures strict citation selection. Neither arm used marketing to justify a use or developer edge.

A manual review against the synthetic evidence checked both free-text reasons in each arm, separately from the deterministic scorer. Both proposals explained that a successful sign-in and an invitation establish no actual activity. Both identified the operator terms as evidence for operation and identified the missing independent developer attribution. The automated decision score checks the chosen action and cited evidence IDs, plus the presence of a reason. The reviewer could see the arm labels.

The [scored pair receipt](receipts/spark-instruction-pair.json) contains both proposals. The earlier [runner bring-up receipt](receipts/spark-runner-bringup.json) shows the same model and budget with two empty responses at the last turn. The harness then added a shared final-turn instruction and JSON object mode when tools were exhausted. The task, type context, evidence, and rubric hashes are unchanged across the two pairs.

One fixture and one trial per arm show similar proposal quality here. Latency includes local serving conditions and the fixed baseline-first order. These observations cover model behavior under the two instruction sets. Production prompt wiring, installation persistence, publication and end-to-end graph writes require separate evidence.
