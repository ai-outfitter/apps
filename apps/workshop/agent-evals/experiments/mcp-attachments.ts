import type { ExperimentConfig } from "@vercel/agent-eval";

export default {
  agent: "workshop-mcp",
  model: "gpt-6-luna",
  runs: 1,
  timeout: 600,
} satisfies ExperimentConfig;
