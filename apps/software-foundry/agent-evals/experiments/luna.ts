import type { ExperimentConfig } from "@vercel/agent-eval";

// Luna through the OpenAI API. The box reads the endpoint and key from
// .env.luna beside this folder (see .env.example); `model` names the model the
// box is told to use. Each eval runs the whole sealed box once: intake, the Foundry workflow with pi in workspaces, merge, release.
const config: ExperimentConfig = {
  // The box agent (box/eval/agent.ts boxAgentName); its transcript is pi sessions.
  agent: "foundry-box-pi-coding-agent",
  model: "gpt-6-luna" as never,
  runs: 1,
  timeout: 1800,
};

export default config;
