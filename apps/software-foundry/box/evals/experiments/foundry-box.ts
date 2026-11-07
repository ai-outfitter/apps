import type { ExperimentConfig } from "@vercel/agent-eval";

// Each eval runs the whole sealed box once: intake, the Foundry workflow with
// pi in workspaces, merge, release. Runs take minutes, so one at a time.
const config: ExperimentConfig = {
  // The box agent (box/eval/agent.ts boxAgentName); its transcript is pi sessions.
  agent: "foundry-box-pi-coding-agent",
  runs: 1,
  timeout: 1800,
};

export default config;
