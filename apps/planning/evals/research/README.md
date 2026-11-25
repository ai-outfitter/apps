# Bounded research eval

Runs real model completions against three fixed public/synthetic evidence packets:
DuckDB source connector versus ontology storage, unavailable pricing with a prompt
injection, and documented offline inference. Public evidence was reviewed on
2026-11-17; the connection-table packet is normalized prose, not a verbatim quote.
No production exports, customer information or credentials belong in fixtures.

```sh
# Configure an existing authorized API credential through secret storage, not Git.
# OPENAI_API_KEY or RESEARCH_EVAL_API_KEY
node --import tsx apps/planning/evals/research/run.ts --out /tmp/research-eval-new --repeats 3
# Validate case preparation without claiming a model evaluation:
node --import tsx apps/planning/evals/research/run.ts --out /tmp/research-eval-dry --dry
```

`RESEARCH_EVAL_MODEL` defaults to the existing digest harness's `gpt-6-luna`.
Choose a model available to your account. `RESEARCH_EVAL_BASE_URL` defaults to
`https://api.openai.com/v1`; a configured OpenAI-compatible endpoint is supported.
Credentials are sent only to the configured endpoint; do not use an untrusted URL.
ChatGPT/Codex login is not an API key and this runner never extracts session tokens.

Reports outside the checkout contain actual model ID, token usage when returned,
measured elapsed milliseconds, raw answers and named checks. No dollar cost is
invented; token prices depend on the chosen endpoint/model. Each request has a
five-minute abort timeout and 2,000 output-token cap; abort cannot guarantee the
provider stops billing. Repeats are bounded to 1–10 (three cases per repeat).

Scoring checks the production research contract, expected outcome, evidence
URL/date/excerpt matching, key terms, absence of invented artifact URLs, measured
latency and self-reported time. Grounding/term checks are deterministic proxies,
not an entailment judge: a contradictory or misleading statement can still pass.
Review raw conclusions before claiming accuracy. The model has no tools, so this
is a frozen-evidence reasoning eval, not live retrieval, MCP, database persistence,
or Planning-to-Onto end-to-end validation. Prompts are harness-specific.

Negative controls explicitly demonstrate that the production contract alone
accepts fabricated evidence and an over-budget reported duration. This harness
adds scoring; it does not change production enforcement or imply safe autonomous
publication. A dry run and unit tests are never model-performance results.
