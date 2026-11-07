// Runs the Workshop box evals with Agent Eval: each fixture under evals/ goes
// through the sealed box (box/eval/agent.ts) and is graded by its EVAL.ts
// against the designs the box committed.
//
//   node --import tsx apps/workshop/box/evals/run.ts [eval ...]
//
// Settings: BOX_CLI (docker or podman, default docker), BOX_IMAGE (default
// outfitter/workshop-box:dev), BOX_PORT (the inspection port, default
// 8787) and BOX_MODEL_ENV (an env file with the model settings, see
// box/README.md, "Models").
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatResultsTable, loadAllFixtures, loadConfig, registerAgent, runExperiment } from "@vercel/agent-eval";
import { boxAgent, type BoxApp } from "@ai-outfitter/box/eval";

const project = fileURLToPath(new URL(".", import.meta.url));
const env = process.env;

/** Workshop's side of the eval: design requests in, committed designs out. */
const workshop: BoxApp = {
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
};

registerAgent(boxAgent({
  name: "workshop-box",
  displayName: "Workshop box",
  cli: env.BOX_CLI || "docker",
  image: env.BOX_IMAGE || "outfitter/workshop-box:dev",
  inspectPort: Number(env.BOX_PORT || 8787),
  modelEnv: env.BOX_MODEL_ENV,
}, workshop));
const resolved = await loadConfig(join(project, "experiments", "workshop-box.ts"));
// One model: the box routes every workspace to the model its env file names.
const config = { ...resolved, model: (Array.isArray(resolved.model) ? resolved.model[0] : resolved.model) ?? "gpt-6-luna" };
const { fixtures, errors } = loadAllFixtures(join(project, "evals"));
for (const error of errors) console.error(error.message);
const selected = process.argv.slice(2);
const chosen = selected.length ? fixtures.filter((fixture) => selected.includes(fixture.name)) : fixtures;
if (!chosen.length) throw new Error("No Workshop box evals selected");
console.log(`Running ${chosen.map((fixture) => fixture.name).join(", ")}; watch the box at http://outfitter.localhost:${env.BOX_PORT || 8787}`);
const results = await runExperiment({
  config,
  fixtures: chosen,
  apiKey: env.OPENAI_API_KEY ?? "",
  resultsDir: join(project, "results"),
  experimentName: "workshop-box",
  onProgress: (event) => console.log(JSON.stringify(event).slice(0, 300)),
});
console.log(formatResultsTable(results));
process.exitCode = results.evals.every((entry) => entry.passedRuns === entry.totalRuns) ? 0 : 1;
