// Provider-only probe. Its inputs describe a synthetic repository and it has no tools.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const { SPARK_BASE_URL, SPARK_AUTHORIZATION, AI_MODEL, SPARK_ACCESS_CLIENT_ID, SPARK_ACCESS_CLIENT_SECRET } = process.env;
const model = AI_MODEL || "GLM-5.3-Flash-EXL3";
const maxCompletionTokens = Number(process.env.SPARK_PROBE_MAX_TOKENS ?? 768);
const noThinking = process.env.SPARK_PROBE_NO_THINKING === "1";
const cases = [
  {
    name: "report-only",
    inputs: "The repo has no contribution templates and no owner fallback. The user asked only for an audit. Suggested repair: add the PR, bug, and feature templates after approval.",
    expected: { reportOnly: true, proposedPaths: [] },
  },
  {
    name: "partial-owner-override",
    inputs: "The owner provides PR, bug, and feature templates. The repo has a maintained custom bug template, which disables both inherited issue templates. Its PR template still inherits. The user approved adding only missing templates without replacing maintained files.",
    expected: { reportOnly: false, proposedPaths: [".github/ISSUE_TEMPLATE/feature_request.md"] },
  },
];
const run = {
  scope: "provider-only synthetic prompt; no Governance route or repository or tools",
  startedAt: new Date().toISOString(),
  model,
  maxCompletionTokens,
  noThinking,
  runner: process.version,
  requests: [],
};

async function call(path, body) {
  const started = performance.now();
  const response = await fetch(`${SPARK_BASE_URL.replace(/\/$/, "")}/${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
    method: body ? "POST" : "GET",
    headers: {
      ...(SPARK_AUTHORIZATION ? { Authorization: SPARK_AUTHORIZATION } : {}),
      ...(SPARK_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": SPARK_ACCESS_CLIENT_ID } : {}),
      ...(SPARK_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": SPARK_ACCESS_CLIENT_SECRET } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const metric = { endpoint: path, httpStatus: response.status, wallMs: 0 };
  run.requests.push(metric);
  if (!response.ok) {
    await response.body?.cancel();
    metric.wallMs = Math.round(performance.now() - started);
    throw new Error("Spark returned an unsuccessful HTTP status.");
  }
  const result = await response.json();
  metric.wallMs = Math.round(performance.now() - started);
  return { result, metric };
}

function evaluate(content, expected) {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g, ""));
    assert.deepEqual(parsed, expected);
    return true;
  } catch {
    return false;
  }
}

try {
  assert.ok(SPARK_BASE_URL, "Set SPARK_BASE_URL from the approved workstation Spark profile.");
  assert.ok(Number.isSafeInteger(maxCompletionTokens) && maxCompletionTokens >= 1 && maxCompletionTokens <= 2048);
  const { result } = await call("models");
  run.modelListed = result.data?.some(({ id }) => id === model) === true;
  assert.ok(run.modelListed, "The requested Spark model is unavailable.");
  for (const { name, inputs, expected } of cases) {
    const { result, metric } = await call("chat/completions", {
      model,
      temperature: 0,
      max_tokens: maxCompletionTokens,
      ...(noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [
        { role: "system", content: "Review the synthetic repository governance scenario. Reply with JSON only: two keys reportOnly (boolean) and proposedPaths (an array of repository paths that the approval permits adding). Do not include a path if approval is absent. Do not propose replacing maintained files." },
        { role: "user", content: inputs },
      ],
    });
    const choice = result.choices?.[0];
    const usage = result.usage ?? {};
    Object.assign(metric, {
      case: name,
      modelMatches: result.model === model,
      finishReason: ["stop", "length", "content_filter"].includes(choice?.finish_reason) ? choice.finish_reason : null,
      promptTokens: Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : null,
      completionTokens: Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : null,
      totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : null,
      completionTokensPerWallSecond: Number.isSafeInteger(usage.completion_tokens) && metric.wallMs
        ? Number((1000 * usage.completion_tokens / metric.wallMs).toFixed(2)) : null,
      passed: evaluate(choice?.message?.content, expected),
    });
  }
  run.passed = run.requests.slice(1).every(({ passed, modelMatches }) => passed && modelMatches);
} catch (error) {
  // Do not print request URLs, response bodies, headers, credentials, or model output.
  run.passed = false;
  run.failure = error.code ?? error.cause?.code ?? error.name;
}
console.log(JSON.stringify(run, null, 2));
if (!run.passed) process.exitCode = 1;
