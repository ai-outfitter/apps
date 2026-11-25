# Forerunner authored graph context eval

This paired [Vercel Agent Eval](https://github.com/vercel-labs/agent-eval) experiment tests whether the namespace presentation from [#267](https://github.com/ai-outfitter/apps/pull/267) changes the quality or cost of discovery proposals for [#266](https://github.com/ai-outfitter/apps/issues/266). The baseline renders installed type names and reads the definition text from the pinned baseline seed. The candidate renders authored Onto and Forerunner names and reads the definition text from the pinned app sources. The projector checks the full directed endpoint sets against the compiled registry and baseline. At these revisions the prose and endpoint sets are equivalent. The treatment changes how the identifiers are rendered.

The fixture has three cases with the same holder, product, publisher, lookup records and base excerpts. The first case covers authentication without an activity record and operator terms without a developer record. The second adds an activity export. The third adds an independently published developer record. The public input contains source excerpts. The expected records, relationships, decisions, and acceptable citation sets live in separate scorer files. Both the holder and operator legal-name queries return a decoy before the verified match. The model must reconcile the account email and legal registration.

The rubric measures supporting citations, canonical identity reuse, exact directed connections, and the record or defer decision. Some checks require direct evidence and accept supplementary citations from a relevance set. The grader checks whether a decision includes a reason. The reasons are available in the receipt for qualitative inspection.

## Run the pair

Use Node 24 and install the repository’s locked dependencies. Set `EVAL_BASE_URL` to a trusted OpenAI-compatible Spark endpoint with model discovery, function calls, and JSON object mode. Set `EVAL_API_KEY` if your endpoint requires authentication.

```sh
EVAL_BASE_URL=http://your-spark:8888/v1 node apps/forerunner/evals/graph-definition-quality/run.mjs
npm -w apps/forerunner run test:unit
npm test
actionlint
```

The shared adapter registers two read-only agents with Agent Eval, runs one case at a time, and alternates which arm goes first. To reuse it, supply a project with `experiments/baseline.ts`, `experiments/candidate.ts`, fixtures under `evals/`, and a `prepare(arm, fixture, prompt)` function like [fixture.mjs](fixture.mjs).

Each invocation writes native Agent Eval results and `pair.json` under a new directory in `results/`. Override the parent with `EVAL_RESULTS_DIR`. The pair receipt records prompt, schema, evidence, lookup, rubric and expected-answer hashes. It also captures messages, tool calls and results, model responses and usage, wall time, and grader output. The Forerunner unit command replays the retained prompts, tool results and grades.

## Refresh the authored schema context

The default run uses [schema-authored.json](evals/connected-discovery/schema-authored.json), projected from #267 at `fcb4eb865bf64cdaa17159930d7ba88f0e4531a2`. Use a clean checkout of the pinned candidate that contains both Git revisions.

```sh
npm --prefix /path/to/candidate ci
node apps/forerunner/evals/graph-definition-quality/project-schema.mjs /path/to/candidate <candidate-sha> > /tmp/schema-authored.json
EVAL_SCHEMA=/tmp/schema-authored.json EVAL_BASE_URL=http://your-spark:8888/v1 node apps/forerunner/evals/graph-definition-quality/run.mjs
```

The projector refuses stale generated files and records the commits, app source paths, and generated artifact SHA-256. The model receives the authored text in full with the complete endpoint constraints. A case supplies the subset of the vocabulary it uses.

## Spark results

The [scored pair](receipts/spark-authored-cases.json) ran on 2026-11-25 using GLM-5.3-Flash-EXL3, model snapshot `25a44fdbf16862a46b7cc9921142c6c81350af2f`, and fingerprint `vllm-0.1.dev20051+g487ecf187-tp2-06793def`. Both arms used Vercel Agent Eval 2.6.0, temperature 0, seed 266, a 120-second deadline per case, up to six model calls, five lookups, and 1,000 completion tokens per call. All six scored runs completed.

| Case | Arm | Grounding | Canonical reuse | Directed relationships | Decisions | Lookups / model calls | Wall time | Input tokens | Output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Authentication only | Baseline | 6/6 | 3/3 | 5/5 | 3/3 | 5 / 6 | 24.06 s | 9,471 | 437 |
| Authentication only | Candidate | 6/6 | 3/3 | 5/5 | 3/3 | 5 / 6 | 26.85 s | 9,862 | 472 |
| Developer record | Baseline | 7/7 | 4/4 | 6/6 | 3/3 | 5 / 6 | 25.76 s | 9,794 | 502 |
| Developer record | Candidate | 7/7 | 2/4 | 4/6 | 3/3 | 5 / 6 | 28.35 s | 10,190 | 581 |
| Workspace activity | Baseline | 7/7 | 3/3 | 6/6 | 3/3 | 5 / 6 | 26.20 s | 9,754 | 490 |
| Workspace activity | Candidate | 7/7 | 3/3 | 6/6 | 3/3 | 5 / 6 | 28.35 s | 10,150 | 570 |

The baseline passed 3/3 cases and the candidate passed 2/3. The candidate recognized the separately registered developer and cited the independent registry, but proposed a duplicate Person in that case even though its lookup returned the correct existing holder and the decoy. The duplicate caused two relationship endpoint misses. Both arms encountered both decoys in every case and selected the correct record-or-defer action each time. The candidate used 1,183 more input tokens and 194 more output tokens across the three cases, with identical lookup and model call counts.

The [earlier 75-second attempt](receipts/spark-deadline-attempt.json) had three inference deadlines. The completed comparison reran all cases in both arms at the same longer deadline. The candidate passed developer attribution in the partial earlier attempt, so a single completed pair per case supplies no estimate of run-to-run stability. Local serving conditions also affect wall time. This result measures proposals under the two rendered contexts. Installation behavior and actual graph writes are outside the experiment.
