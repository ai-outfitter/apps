export const model = 'GLM-5.3-Flash-EXL3';
export const limits = {
  modelCalls: 6,
  toolCalls: 5,
  tokensPerCall: 1000,
  temperature: 0,
  seed: 266,
  timeoutSeconds: 120,
};

export const requestOptions = { chat_template_kwargs: { enable_thinking: false } };
export const modelRevisionOf = ({ root }) => root?.match(/\/snapshots\/([a-f0-9]{40})(?:\/|$)/)?.[1];

export function experiment(arm) {
  return { agent: `read-only-${arm}`, model, timeout: limits.timeoutSeconds, runs: 1, earlyExit: false };
}
