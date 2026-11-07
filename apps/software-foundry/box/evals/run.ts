// Runs the Software Foundry box evals with Agent Eval: each fixture under
// evals/ goes through the sealed box (packages/box/eval/agent.ts) and is
// graded by its EVAL.ts.
//
//   node --import tsx apps/software-foundry/box/evals/run.ts [eval ...]
//
// Settings: BOX_CLI (docker or podman, default docker), BOX_IMAGE (default
// outfitter/software-foundry-box:dev), BOX_PORT (the inspection port, default
// 8787) and BOX_MODEL_ENV (an env file with the model settings, see
// packages/box/README.md, "Models").
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatResultsTable, loadAllFixtures, loadConfig, registerAgent, runExperiment } from "@vercel/agent-eval";
import { boxAgent, type BoxApp } from "@ai-outfitter/box/eval";

const project = fileURLToPath(new URL(".", import.meta.url));
const env = process.env;

/** Software Foundry's side of the eval: work requests in, landed changes out. */
const foundry: BoxApp = {
  requestFromPrompt(prompt) {
    const [title = "Eval task", ...rest] = prompt.trim().split("\n");
    return {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      kind: "feature",
      title: title.replace(/^#+\s*/, "").slice(0, 200),
      problem: prompt.trim(),
      acceptanceCriteria: [{ id: "eval", text: rest.join("\n").trim() || prompt.trim() }],
      delivery: "pull_request",
    };
  },
  succeeded: (result) => result.status === "landed",
};

registerAgent(boxAgent({
  name: "foundry-box",
  displayName: "Software Foundry box",
  cli: env.BOX_CLI || "docker",
  image: env.BOX_IMAGE || "outfitter/software-foundry-box:dev",
  inspectPort: Number(env.BOX_PORT || 8787),
  modelEnv: env.BOX_MODEL_ENV,
}, foundry));
const resolved = await loadConfig(join(project, "experiments", "foundry-box.ts"));
// One model: the box routes every workspace to the model its env file names.
const config = { ...resolved, model: (Array.isArray(resolved.model) ? resolved.model[0] : resolved.model) ?? "gpt-6-luna" };
const { fixtures, errors } = loadAllFixtures(join(project, "evals"));
for (const error of errors) console.error(error.message);
const selected = process.argv.slice(2);
const chosen = selected.length ? fixtures.filter((fixture) => selected.includes(fixture.name)) : fixtures;
if (!chosen.length) throw new Error("No Software Foundry box evals selected");
console.log(`Running ${chosen.map((fixture) => fixture.name).join(", ")}; watch the box at http://outfitter.localhost:${env.BOX_PORT || 8787}`);
const results = await runExperiment({
  config,
  fixtures: chosen,
  apiKey: env.OPENAI_API_KEY ?? "",
  resultsDir: join(project, "results"),
  experimentName: "foundry-box",
  onProgress: (event) => console.log(JSON.stringify(event).slice(0, 300)),
});
console.log(formatResultsTable(results));
process.exitCode = results.evals.every((entry) => entry.passedRuns === entry.totalRuns) ? 0 : 1;
