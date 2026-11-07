// Time and model use for a box result, the same shape for every box: each
// step's wall time, model calls and tokens, and the totals for the request.
// Tokens are null when the provider did not report them.

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const seconds = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / 100) / 10 : 0);
/** A sum that is null when any part is unknown. */
const total = (values) => (values.length && values.every((value) => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null);

/**
 * One step: `calls` are its model calls, each with input and output tokens.
 * @param {{ name: string, status: string, startedAt?: number, finishedAt?: number,
 *   calls?: { input?: number | null, output?: number | null }[] }} step
 */
export function stepMetrics({ name, status, startedAt, finishedAt, calls = [] }) {
  return {
    name,
    status,
    seconds: seconds(startedAt, finishedAt),
    modelCalls: calls.length,
    inputTokens: calls.length ? total(calls.map((call) => count(call.input))) : 0,
    outputTokens: calls.length ? total(calls.map((call) => count(call.output))) : 0,
  };
}

/**
 * The request's metrics from its steps. Output tokens per second count only
 * the time of steps that called the model.
 * @param {ReturnType<typeof stepMetrics>[]} steps
 * @param {{ startedAt: string, finishedAt: string }} span
 */
export function runMetrics(steps, { startedAt, finishedAt }) {
  const modelSteps = steps.filter((step) => step.modelCalls > 0);
  const modelSeconds = Math.round(modelSteps.reduce((sum, step) => sum + step.seconds, 0) * 10) / 10;
  const outputTokens = total(steps.map((step) => step.outputTokens));
  return {
    wallSeconds: seconds(Date.parse(startedAt), Date.parse(finishedAt)),
    modelSeconds,
    modelCalls: steps.reduce((sum, step) => sum + step.modelCalls, 0),
    inputTokens: total(steps.map((step) => step.inputTokens)),
    outputTokens,
    outputTokensPerSecond: outputTokens !== null && modelSeconds > 0 ? Math.round((outputTokens / modelSeconds) * 10) / 10 : null,
    steps,
  };
}
