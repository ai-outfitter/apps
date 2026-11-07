import type { ExperimentConfig } from "@vercel/agent-eval";

// Each eval runs the whole sealed box once: the design agent's turns, the
// model export, the design commit and the release. One at a time.
const config: ExperimentConfig = {
  // The box agent (box/eval/agent.ts boxAgentName); its transcript is pi sessions.
  agent: "workshop-box-pi-coding-agent",
  runs: 1,
  timeout: 1200,
};

export default config;
