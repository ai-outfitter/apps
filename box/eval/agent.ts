// An app box as an Agent Eval agent. A run turns the eval fixture into a git
// repository and a request, runs the sealed box image on it (its platform is
// inspectable on a local port while it works), and grades the repository the
// box left on its default branch with the fixture's EVAL.ts. Each app's evals
// (apps/<app>/agent-evals) say how a fixture becomes a request and what counts
// as a passing result.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { formatResultsTable, loadAllFixtures, loadConfig, registerAgent, runExperiment } from "@vercel/agent-eval";
import type { Agent, AgentRunOptions, AgentRunResult } from "@vercel/agent-eval";

const require = createRequire(import.meta.url);
// A fixture's reference/ folder (a reference part to score against) is for grading only.
const hidden = new Set(["PROMPT.md", "EVAL.ts", "EVAL.tsx", "request.json", "reference", "node_modules", ".git"]);
const geometryModule = fileURLToPath(new URL("./geometry.ts", import.meta.url));

export type BoxOptions = {
  /** Agent name, as experiments name it. */
  name: string;
  displayName: string;
  /** Container CLI: docker or podman. */
  cli: string;
  image: string;
  /** Host port for the box's platform, for watching a run. */
  inspectPort: number;
  /** The host port Forgejo is published on (BOX_FORGEJO_PORT, 3300: its links name 127.0.0.1:3300). */
  forgejoPort: number;
  /** Env file with the model settings (README, "Models"). */
  modelEnv?: string;
  /** Where each run's agent sessions are kept (`<dir>/<requestId>/<agent>.jsonl`). */
  sessionsDir?: string;
  /** Where each run's UI screenshots are kept (`<dir>/<eval>/<n>-<step>.png`), for boxes that take them. */
  screenshotsDir?: string;
  /** One box run's limit in ms, counted from when it starts rather than while it waits its turn. */
  runTimeoutMs?: number;
  /** The experiment being run, for an app that prepares its requests by experiment. */
  experiment?: string;
};

function git(directory: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", directory, "-c", "user.name=Agent Eval", "-c", "user.email=eval@box.local", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Every file under a directory, relative, without what an eval hides from the agent. */
function files(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (hidden.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(root, path) : [relative(root, path)];
  });
}

/** How an app's evals talk to its box. */
export type BoxApp = {
  /** The request for a fixture without a request.json, made from its PROMPT.md. */
  requestFromPrompt(prompt: string): { requestId: string } & Record<string, unknown>;
  /** Whether the run-result the box wrote is a finished, successful run. */
  succeeded(result: any): boolean;
  /** The experiment whose `.env.<name>` holds this experiment's model settings, for experiments
   * that share a model and differ in how they reach the agent (default: the experiment itself). */
  modelEnv?(experiment: string): string;
  /** The request as this experiment sends it, for an experiment that reaches the same agent another way. */
  prepareRequest?<T extends { requestId: string } & Record<string, unknown>>(request: T, experiment: string): T;
};

/** The fixture's request.json, or one the app makes from PROMPT.md. */
export function fixtureRequest(app: BoxApp, fixture: string, prompt: string, experiment?: string) {
  const file = join(fixture, "request.json");
  const request = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : app.requestFromPrompt(prompt);
  return experiment && app.prepareRequest ? app.prepareRequest(request, experiment) : request;
}

/** Runs the box to completion, streaming its log, within the eval's timeout. */
function runBox(box: BoxOptions, work: string, timeout: number, signal?: AbortSignal) {
  const name = `${box.name}-eval-${work.split("-").pop()}`;
  // The platform is published on every interface and told this machine's bare hostname, so another
  // device opens it at http://<hostname>:<port> (the webapp's OUTFITTER_LOCAL_HOSTNAME). Forgejo is
  // published on loopback, at the port its ROOT_URL names, so the box's PRs and their screenshots can be viewed while it runs.
  const args = ["run", "--rm", "--name", name, "-p", `${box.inspectPort}:8787`, "-p", `127.0.0.1:${box.forgejoPort}:3300`,
    "-e", `OUTFITTER_LOCAL_HOSTNAME=${hostname().split(".")[0]}`, "-e", "BOX_EXIT_WHEN_DONE=1",
    ...(box.modelEnv ? ["--env-file", box.modelEnv] : []),
    "-v", `${join(work, "repo")}:/in/repo:ro`, "-v", `${join(work, "requests")}:/in/requests:ro`, "-v", `${join(work, "out")}:/out`, box.image];
  return new Promise<{ code: number | null; log: string }>((done) => {
    const child = spawn(box.cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const append = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-512_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => spawnSync(box.cli, ["stop", "-t", "5", name]);
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, log });
    });
  });
}

/** The box's final default branch, checked out from its history bundle. */
function finalTree(work: string, branch: string) {
  const final = join(work, "final");
  const result = spawnSync("git", ["clone", "--quiet", "--branch", branch, join(work, "out", "repo.bundle"), final], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`The box left no ${branch} history: ${result.stderr}`);
  return final;
}

/** Grades the final tree with the fixture's EVAL.ts, using the vitest installed with this package.
 * EVAL.ts can import the geometry scorer as "@ai-outfitter/box/geometry", reads the fixture's
 * reference/ beside it, and the scores it records (recordScore) come back as `geometry`. */
export function grade(fixture: string, tree: string) {
  const evalFile = ["EVAL.ts", "EVAL.tsx"].find((name) => existsSync(join(fixture, name)));
  if (!evalFile) return { success: false, output: "The fixture has no EVAL.ts" };
  cpSync(join(fixture, evalFile), join(tree, evalFile));
  if (existsSync(join(fixture, "reference"))) cpSync(join(fixture, "reference"), join(tree, "reference"), { recursive: true });
  // vitest's default include does not match EVAL.ts; this run includes only it.
  const config = join(tree, "..", "vitest.eval.config.mjs");
  writeFileSync(config, `export default { resolve: { alias: { "@ai-outfitter/box/geometry": ${JSON.stringify(geometryModule)} } }, test: { include: [${JSON.stringify(evalFile)}] } };\n`);
  const scores = join(tree, "..", "geometry-scores.json");
  const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, "run", "--root", tree, "--config", config, "--reporter", "verbose"],
    { cwd: tree, encoding: "utf8", env: { ...process.env, BOX_EVAL_SCORES: scores } });
  const geometry = existsSync(scores) ? JSON.parse(readFileSync(scores, "utf8")) : undefined;
  return { success: result.status === 0, output: `${result.stdout}${result.stderr}`, geometry };
}

/** One box run's time and model use, for comparing models (results/<experiment>/metrics-<time>.json). */
export type RunMetrics = { eval: string; success: boolean; status?: string; model?: { provider: string; id: string };
  durationSeconds: number; metrics?: any;
  /** Geometry scores the eval recorded, by part (geometry.ts summary). */
  geometry?: Record<string, { iou: number | null; chamferMm: number | null; watertight: boolean }> };

/** Each run's metrics, one line per run, so two models' runs can be read side by side. */
export function metricsTable(runs: RunMetrics[]) {
  const value = (number: unknown) => (number === null || number === undefined ? "–" : String(number));
  const rows = runs.map((run) => [run.eval, `${run.model?.provider ?? "?"}/${run.model?.id ?? "?"}`, run.success ? "pass" : `fail (${run.status ?? "no result"})`,
    value(run.metrics?.wallSeconds ?? run.durationSeconds), value(run.metrics?.modelSeconds), value(run.metrics?.modelCalls),
    value(run.metrics?.inputTokens), value(run.metrics?.outputTokens), value(run.metrics?.outputTokensPerSecond)]);
  const header = ["eval", "model", "result", "wall s", "model s", "calls", "tokens in", "tokens out", "out tok/s"];
  // Evals that score geometry add the parts' IoU and Chamfer distance (the mean when there are several).
  if (runs.some((run) => run.geometry)) {
    header.push("IoU", "chamfer mm", "watertight");
    runs.forEach((run, index) => {
      const parts = Object.values(run.geometry ?? {});
      const average = (key: "iou" | "chamferMm") => {
        const values = parts.map((part) => part[key]);
        return values.length && values.every((v) => v !== null) ? String(Math.round((values as number[]).reduce((a, b) => a + b, 0) / values.length * 1000) / 1000) : "–";
      };
      rows[index].push(average("iou"), average("chamferMm"), parts.length ? (parts.every((part) => part.watertight) ? "yes" : "no") : "–");
    });
  }
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows].map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n");
}

/** The agent's name as experiments use it. Agent Eval picks its transcript
 * parser by the agent's name, so the name carries pi's ("pi-coding-agent"):
 * the transcript is the box's agent sessions in pi's format. */
export const boxAgentName = (box: { name: string }) => `${box.name}-pi-coding-agent`;

export function boxAgent(box: BoxOptions, app: BoxApp, runs: RunMetrics[] = []): Agent {
  // Agent Eval starts every fixture at once, but each box publishes its platform on
  // the same inspection port, so a second box would exit at once. Boxes run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    name: boxAgentName(box),
    displayName: box.displayName,
    getApiKeyEnvVar: () => "OPENAI_API_KEY",
    getDefaultModel: () => "gpt-6-luna" as never,
    // The box brings its own harness (pi inside workspaces); nothing is installed in a sandbox.
    definition: { o11yAgentName: "pi-coding-agent" } as unknown as Agent["definition"],
    run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
      return oneAtATime(() => runOne(fixturePath, options));
    },
  };

  async function runOne(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
      const started = Date.now();
      const work = mkdtempSync(join(tmpdir(), `${box.name}-eval-`));
      try {
        const repo = join(work, "repo");
        const original = files(fixturePath);
        for (const file of original) {
          mkdirSync(join(repo, file, ".."), { recursive: true });
          cpSync(join(fixturePath, file), join(repo, file));
        }
        git(work, "init", "--quiet", "--initial-branch=main", "repo");
        git(repo, "add", "-A");
        git(repo, "commit", "--quiet", "-m", "Eval fixture");
        const request = fixtureRequest(app, fixturePath, options.prompt, box.experiment);
        mkdirSync(join(work, "requests"));
        writeFileSync(join(work, "requests", "request.json"), JSON.stringify(request, null, 2));
        mkdirSync(join(work, "out"));
        // The box runs as its own user; it writes results here.
        chmodSync(join(work, "out"), 0o777);
        const ran = await runBox(box, work, box.runTimeoutMs ?? options.timeout, options.signal);
        const resultFile = join(work, "out", "results", `${request.requestId.toLowerCase()}.json`);
        const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined;
        // Every agent's session (box/sessions.mjs): kept beside the results, and merged for Agent Eval's transcript.
        const sessions = join(work, "out", "sessions", request.requestId.toLowerCase());
        if (box.sessionsDir && existsSync(sessions)) cpSync(sessions, join(box.sessionsDir, request.requestId.toLowerCase()), { recursive: true });
        // The app's UI as the box saw it after each step (Workshop's workbench screenshots).
        const screenshots = join(work, "out", "screenshots", request.requestId.toLowerCase());
        if (box.screenshotsDir && existsSync(screenshots)) cpSync(screenshots, join(box.screenshotsDir, basename(fixturePath)), { recursive: true });
        const transcriptFile = join(sessions, "transcript.jsonl");
        const transcript = existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : result && JSON.stringify(result);
        const measured = (success: boolean) => runs.push({ eval: basename(fixturePath), success, status: result?.status, model: result?.model,
          durationSeconds: Math.round((Date.now() - started) / 100) / 10, metrics: result?.metrics });
        if (!result) {
          measured(false);
          return { success: false, output: ran.log, error: `The box wrote no result (exit ${ran.code})`, duration: Date.now() - started,
            ...(transcript ? { transcript } : {}) };
        }
        const tree = finalTree(work, "main");
        const { geometry, ...testResult } = grade(fixturePath, tree);
        measured(app.succeeded(result) && testResult.success);
        if (geometry) runs[runs.length - 1].geometry = geometry;
        const after = files(tree);
        const generatedFiles = Object.fromEntries(after.filter((file) => !original.includes(file) ||
          !readFileSync(join(tree, file)).equals(readFileSync(join(fixturePath, file)))).map((file) => [file, readFileSync(join(tree, file))]));
        return {
          success: app.succeeded(result) && testResult.success,
          output: ran.log,
          transcript,
          ...(app.succeeded(result) ? {} : { error: `Run ${result.status}: ${result.reason ?? ""}` }),
          duration: Date.now() - started,
          testResult,
          generatedFiles,
          deletedFiles: original.filter((file) => !after.includes(file)),
          observedModel: result.model?.id,
        };
      } finally {
        // The box's files belong to its container user; a rootless runtime removes them as that user.
        spawnSync(box.cli, ["run", "--rm", "--user", "0", "--entrypoint", "rm", "-v", `${work}:/work`, box.image, "-rf", "/work/out"]);
        try {
          rmSync(work, { recursive: true, force: true });
        } catch (error) {
          console.error(`Could not remove ${work}: ${(error as Error).message}`);
        }
      }
  }
}

/** Runs an app's box evals with Agent Eval, in its `agent-evals/` project (the Agent Eval layout):
 * `run.ts <experiment> [eval ...]` runs every fixture under `evals/` (or the ones named) through the
 * box with `experiments/<experiment>.ts`, one file per model, and grades each with its EVAL.ts.
 * The box gets that model's settings from `.env.<experiment>` (see `.env.example`), and results go to
 * `results/<experiment>/`. Settings: BOX_CLI (docker or podman), BOX_IMAGE, BOX_PORT (the inspection
 * port) and BOX_FORGEJO_PORT (Forgejo, 3300). */
export async function runBoxEvals(project: string, box: { name: string; displayName: string; image: string }, app: BoxApp) {
  const env = process.env;
  const [experiment, ...selected] = process.argv.slice(2);
  const experiments = readdirSync(join(project, "experiments")).filter((file) => file.endsWith(".ts")).map((file) => file.slice(0, -3));
  if (!experiment || !experiments.includes(experiment)) throw new Error(`Name an experiment first: ${experiments.join(", ")}`);
  const modelEnv = join(project, `.env.${app.modelEnv?.(experiment) ?? experiment}`);
  if (!existsSync(modelEnv)) throw new Error(`${modelEnv} is missing: copy .env.example and fill in the ${experiment} model settings`);
  const port = Number(env.BOX_PORT || 8787);
  const runs: RunMetrics[] = [];
  const resultsDir = join(project, "results");
  const sessionsDir = join(resultsDir, experiment, "sessions");
  const screenshotsDir = join(resultsDir, experiment, "screenshots");
  // Agent Eval checks an experiment's agent when it loads it, so the agent is registered first;
  // its per-run limit is set from the experiment once loaded.
  const options: BoxOptions = { ...box, cli: env.BOX_CLI || "docker", image: env.BOX_IMAGE || box.image, inspectPort: port, forgejoPort: Number(env.BOX_FORGEJO_PORT || 3300), modelEnv, sessionsDir, screenshotsDir, experiment };
  registerAgent(boxAgent(options, app, runs));
  const resolved = await loadConfig(join(project, "experiments", `${experiment}.ts`));
  options.runTimeoutMs = resolved.timeout * 1000;
  const { fixtures, errors } = loadAllFixtures(join(project, "evals"));
  for (const error of errors) console.error(error.message);
  const chosen = selected.length ? fixtures.filter((fixture) => selected.includes(fixture.name)) : fixtures;
  if (!chosen.length) throw new Error(`No ${box.displayName} evals selected`);
  // One model per experiment: the box routes every call to the model its env file names. Agent Eval
  // starts every eval's clock at once while boxes take turns, so its limit covers the whole queue
  // and each box run keeps the experiment's timeout from when it starts.
  const config = { ...resolved, timeout: resolved.timeout * chosen.length * (resolved.runs ?? 1),
    model: (Array.isArray(resolved.model) ? resolved.model[0] : resolved.model) ?? "gpt-6-luna" };
  console.log(`Running ${chosen.map((fixture) => fixture.name).join(", ")}; watch the box at http://outfitter.localhost:${port}`);
  const results = await runExperiment({
    config,
    fixtures: chosen,
    apiKey: env.OPENAI_API_KEY ?? "",
    resultsDir,
    experimentName: experiment,
    onProgress: (event) => console.log(JSON.stringify(event).slice(0, 300)),
  });
  console.log(formatResultsTable(results));
  // Time and model use per run, kept next to Agent Eval's results so models can be compared.
  mkdirSync(join(resultsDir, experiment), { recursive: true });
  const file = join(resultsDir, experiment, `metrics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ experiment, image: env.BOX_IMAGE || box.image, runs }, null, 2)}\n`);
  console.log(`\n${metricsTable(runs)}\n\nMetrics: ${file}\nAgent sessions: ${sessionsDir}${existsSync(screenshotsDir) ? `\nScreenshots: ${screenshotsDir}` : ""}`);
  process.exitCode = results.evals.every((entry) => entry.passedRuns === entry.totalRuns) ? 0 : 1;
}
