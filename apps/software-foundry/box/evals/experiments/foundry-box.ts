import type { ExperimentConfig } from "@vercel/agent-eval";

// Each eval runs the whole sealed box once: intake, the Foundry workflow with
// pi in workspaces, merge, release. Runs take minutes, so one at a time.
const config: ExperimentConfig = {
  agent: "foundry-box",
  runs: 1,
  timeout: 1800,
};

export default config;
