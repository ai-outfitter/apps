import type { ExperimentConfig } from "@vercel/agent-eval";

// Luna through the OpenAI API. The box reads the endpoint and key from
// .env.luna beside this folder (see .env.example); `model` names the model the
// box is told to use. Each eval runs the whole sealed box once: the design agent's turns, the model export, the design commit and the release.
const config: ExperimentConfig = {
  // The box agent (box/eval/agent.ts boxAgentName); its transcript is pi sessions.
  agent: "workshop-box-pi-coding-agent",
  model: "gpt-6-luna" as never,
  runs: 1,
  timeout: 1200,
};

export default config;
