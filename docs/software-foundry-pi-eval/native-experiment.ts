import type { ExperimentConfig } from "@vercel/agent-eval";

const model = process.env.FOUNDRY_EVAL_NATIVE_MODEL;
if (!model) throw new Error("Set the pinned native Pi model in FOUNDRY_EVAL_NATIVE_MODEL");

const config: ExperimentConfig = {
  agent: "foundry-box-pi-coding-agent",
  model: model as never,
  runs: 1,
  timeout: 3600,
};
export default config;
