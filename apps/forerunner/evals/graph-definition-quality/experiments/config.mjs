export const model = 'GLM-5.3-Flash-EXL3';
export const limits = {
  modelCalls: 5,
  toolCalls: 4,
  tokensPerCall: 1000,
  temperature: 0,
  seed: 266,
  timeoutSeconds: 75,
};

export function experiment(arm) {
  return { agent: `read-only-${arm}`, model, timeout: limits.timeoutSeconds, runs: 1, earlyExit: false };
}
