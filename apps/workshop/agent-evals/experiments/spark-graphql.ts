import type { ExperimentConfig } from "@vercel/agent-eval";
import spark from "./spark";

// The DGX Spark, with every design turn started through the platform's graph API
// instead of posted to Workshop's design route: the StartWorkshopDesign mutation
// (MCP graph_mutate), then its run followed with WorkshopDesignRun. The model
// settings are .env.spark's, and each fixture is graded by the same EVAL.ts,
// so results/spark-graphql compares directly with results/spark.
const config: ExperimentConfig = { ...spark };

export default config;
