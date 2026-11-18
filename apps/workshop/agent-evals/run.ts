// Runs the Workshop box evals with Agent Eval: each fixture under evals/ goes
// through the sealed box and is graded by its EVAL.ts against the designs the
// box committed.
//
//   node --import tsx apps/workshop/agent-evals/run.ts <experiment> [eval ...]
//
// <experiment> is a file in experiments/ (luna, spark): one per model, with the
// model settings in .env.<experiment> (.env.example). luna-graphql and
// spark-graphql run the same fixtures on the same models (.env.luna,
// .env.spark) with every design turn started through the platform's graph API
// (the StartWorkshopDesign mutation) instead of posted to the design route, and
// are graded by the same EVAL.ts.
//
// Settings: see runBoxEvals in box/eval/agent.ts.
import { fileURLToPath } from "node:url";
import { runBoxEvals } from "@ai-outfitter/box/eval";

await runBoxEvals(fileURLToPath(new URL(".", import.meta.url)), {
  name: "workshop-box", displayName: "Workshop box", image: "outfitter/workshop-box:dev",
}, {
  // A fixture without request.json is a design request made from its PROMPT.md.
  requestFromPrompt(prompt) {
    const [title = "Eval design", ...rest] = prompt.trim().split("\n");
    return {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      title: title.replace(/^#+\s*/, "").slice(0, 200),
      message: (rest.join(" ").trim() || prompt.trim()).slice(0, 500),
    };
  },
  succeeded: (result) => result.status === "designed",
  // `<model>-graphql` shares the model's settings and starts each turn with the mutation.
  modelEnv: (experiment) => experiment.replace(/-graphql$/, ""),
  prepareRequest: (request, experiment) => (experiment.endsWith("-graphql") ? { ...request, via: "graphql" } : request),
});
