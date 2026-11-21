import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerAgent,
  loadConfig,
  loadAllFixtures,
  runExperiment,
  formatResultsTable,
} from "@vercel/agent-eval";
import { grade } from "@ai-outfitter/box/eval";
import { exercise } from "./subject";

export async function runAttachments(project: string, selected: string[]) {
  const experiment = "mcp-attachments";
  const resultsDir = join(project, "results");
  const inputs = ["spacer.step", "spacer.stl"];
  registerAgent({
    name: "workshop-mcp",
    displayName: "Workshop MCP client",
    definition: { o11yAgentName: "workshop-mcp" } as never,
    getApiKeyEnvVar: () => "OPENAI_API_KEY",
    getDefaultModel: () => "gpt-6-luna" as never,
    async run(fixture, options) {
      const start = Date.now();
      const work = mkdtempSync(join(tmpdir(), "workshop-agent-eval-"));
      const tree = join(work, "grader");
      mkdirSync(tree);
      try {
        for (const name of inputs)
          copyFileSync(join(fixture, name), join(tree, name));
        const evidence = await exercise(fixture, inputs, options);
        const output = JSON.stringify(evidence, null, 2);
        writeFileSync(join(tree, "evidence.json"), output);
        const report = join(
          resultsDir,
          experiment,
          evidence.projectId + ".json",
        );
        mkdirSync(join(resultsDir, experiment), { recursive: true });
        writeFileSync(report, output);
        const testResult = grade(fixture, tree);
        console.log(testResult.output, "\nEvidence:", report);
        return {
          success: testResult.success,
          testResult,
          duration: Date.now() - start,
          output: evidence.answer,
          observedModel: evidence.model,
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });
  const config = await loadConfig(
    join(project, "experiments", experiment + ".ts"),
  );
  const { fixtures, errors } = loadAllFixtures(join(project, "mcp/evals"));
  if (errors.length) throw Error(errors.map((e) => e.message).join("\n"));
  if (selected.some((name) => !fixtures.some((f) => f.name === name)))
    throw Error("Unknown MCP eval case");
  if (typeof config.model !== "string")
    throw Error("Select one subject model per experiment");
  const results = await runExperiment({
    config: { ...config, model: config.model },
    fixtures: fixtures.filter(
      (f) => !selected.length || selected.includes(f.name),
    ),
    apiKey: process.env.OPENAI_API_KEY ?? "",
    resultsDir,
    experimentName: experiment,
  });
  console.log(formatResultsTable(results));
  process.exitCode =
    results.evals.length &&
    results.evals.every((e) => e.totalRuns > 0 && e.passedRuns === e.totalRuns)
      ? 0
      : 1;
}
