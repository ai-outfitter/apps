import type { ExperimentConfig } from "@vercel/agent-eval";

// Shared starting point for repository and packaged-app coding-agent tasks.
// The dry run reads this config without creating a sandbox or contacting a model.
const config: ExperimentConfig = {
  agent: "codex",
  sandbox: "docker",
  runs: 1,
  timeout: 600,
};

export default config;
