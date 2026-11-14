import type { ExperimentConfig } from "@vercel/agent-eval";

// The DGX Spark. It is slower than Luna, so runs get longer. The box reads the endpoint and key from
// .env.spark beside this folder (see .env.example); `model` names the model the
// box is told to use. Each eval runs the whole sealed box once: intake, the Foundry workflow with pi in workspaces, merge, release.
const config: ExperimentConfig = {
  // The box agent (box/eval/agent.ts boxAgentName); its transcript is pi sessions.
  agent: "foundry-box-pi-coding-agent",
  model: "GLM-5.3-Flash-EXL3" as never,
  runs: 1,
  timeout: 10800,
};

export default config;
