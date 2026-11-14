import type { ExperimentConfig } from "@vercel/agent-eval";
import luna from "./luna";

// Luna through the OpenAI API, with every design turn started through the platform's graph API
// instead of posted to Workshop's design route: the StartWorkshopDesign mutation
// (MCP graph_mutate), then its run followed with WorkshopDesignRun. The model
// settings are .env.luna's, and each fixture is graded by the same EVAL.ts,
// so results/luna-graphql compares directly with results/luna.
const config: ExperimentConfig = { ...luna };

export default config;
