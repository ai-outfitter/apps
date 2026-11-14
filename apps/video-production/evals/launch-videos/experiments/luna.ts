import type { ExperimentConfig } from "@vercel/agent-eval";

// The launch-video request on the Sunny and Outfitter Ontos, Luna acting and judging.
// outfitter-pi is the platform runner's agent (webapp evals/outfitter/lib/outfitter-pi.ts):
// it starts a disposable Outfitter from each fixture's checkpoint and seed, runs the
// agent against its MCP server and then EVAL.ts.
const config: ExperimentConfig = {
  agent: "outfitter-pi",
  model: "luna",
  agentOptions: { judge: "luna" },
  runs: 3,
  earlyExit: false,
  timeout: 600,
  copyFiles: "changed",
};

export default config;
