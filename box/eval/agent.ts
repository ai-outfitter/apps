// An app box as an Agent Eval agent. A run turns the eval fixture into a git
// repository and a request, runs the sealed box image on it (its platform is
// inspectable on a local port while it works), and grades the repository the
// box left on its default branch with the fixture's EVAL.ts. Each app's evals
// (apps/<app>/box/evals) say how a fixture becomes a request and what counts
// as a passing result.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { formatResultsTable, loadAllFixtures, loadConfig, registerAgent, runExperiment } from "@vercel/agent-eval";
import type { Agent, AgentRunOptions, AgentRunResult } from "@vercel/agent-eval";

const require = createRequire(import.meta.url);
const hidden = new Set(["PROMPT.md", "EVAL.ts", "EVAL.tsx", "request.json", "node_modules", ".git"]);

export type BoxOptions = {
  /** Agent name, as experiments name it. */
  name: string;
  displayName: string;
  /** Container CLI: docker or podman. */
  cli: string;
  image: string;
  /** Host port for the box's platform, for watching a run. */
  inspectPort: number;
  /** Env file with the model settings (README, "Models"). */
  modelEnv?: string;
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
};

/** The fixture's request.json, or one the app makes from PROMPT.md. */
export function fixtureRequest(app: BoxApp, fixture: string, prompt: string) {
  const file = join(fixture, "request.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return app.requestFromPrompt(prompt);
}

/** Runs the box to completion, streaming its log, within the eval's timeout. */
function runBox(box: BoxOptions, work: string, timeout: number, signal?: AbortSignal) {
  const name = `${box.name}-eval-${work.split("-").pop()}`;
  const args = ["run", "--rm", "--name", name, "-p", `127.0.0.1:${box.inspectPort}:8787`, "-e", "BOX_EXIT_WHEN_DONE=1",
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

/** Grades the final tree with the fixture's EVAL.ts, using the vitest installed with this package. */
function grade(fixture: string, tree: string) {
  const evalFile = ["EVAL.ts", "EVAL.tsx"].find((name) => existsSync(join(fixture, name)));
  if (!evalFile) return { success: false, output: "The fixture has no EVAL.ts" };
  cpSync(join(fixture, evalFile), join(tree, evalFile));
  // vitest's default include does not match EVAL.ts; this run includes only it.
  const config = join(tree, "..", "vitest.eval.config.mjs");
  writeFileSync(config, `export default { test: { include: [${JSON.stringify(evalFile)}] } };\n`);
  const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, "run", "--root", tree, "--config", config, "--reporter", "verbose"], { cwd: tree, encoding: "utf8" });
  return { success: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

export function boxAgent(box: BoxOptions, app: BoxApp): Agent {
  return {
    name: box.name,
    displayName: box.displayName,
    getApiKeyEnvVar: () => "OPENAI_API_KEY",
    getDefaultModel: () => "gpt-6-luna" as never,
    // The box brings its own harness (pi inside workspaces); nothing is installed in a sandbox.
    definition: { o11yAgentName: "pi-coding-agent" } as unknown as Agent["definition"],
    async run(fixturePath: string, options: AgentRunOptions): Promise<AgentRunResult> {
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
        const request = fixtureRequest(app, fixturePath, options.prompt);
        mkdirSync(join(work, "requests"));
        writeFileSync(join(work, "requests", "request.json"), JSON.stringify(request, null, 2));
        mkdirSync(join(work, "out"));
        // The box runs as its own user; it writes results here.
        chmodSync(join(work, "out"), 0o777);
        const ran = await runBox(box, work, options.timeout, options.signal);
        const resultFile = join(work, "out", "results", `${request.requestId.toLowerCase()}.json`);
        const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined;
        if (!result) return { success: false, output: ran.log, error: `The box wrote no result (exit ${ran.code})`, duration: Date.now() - started };
        const tree = finalTree(work, "main");
        const testResult = grade(fixturePath, tree);
        const after = files(tree);
        const generatedFiles = Object.fromEntries(after.filter((file) => !original.includes(file) ||
          !readFileSync(join(tree, file)).equals(readFileSync(join(fixturePath, file)))).map((file) => [file, readFileSync(join(tree, file))]));
        return {
          success: app.succeeded(result) && testResult.success,
          output: ran.log,
          transcript: JSON.stringify(result),
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
    },
  };
}

/** Runs an app's box evals with Agent Eval: every fixture under `<project>/evals`
 * (or the ones named on the command line) through the box, graded by its EVAL.ts.
 * Settings: BOX_CLI (docker or podman), BOX_IMAGE, BOX_PORT (the inspection port)
 * and BOX_MODEL_ENV (an env file with the model settings, box/README.md, "Models"). */
export async function runBoxEvals(project: string, box: { name: string; displayName: string; image: string }, app: BoxApp) {
  const env = process.env;
  const port = Number(env.BOX_PORT || 8787);
  registerAgent(boxAgent({ ...box, cli: env.BOX_CLI || "docker", image: env.BOX_IMAGE || box.image, inspectPort: port, modelEnv: env.BOX_MODEL_ENV }, app));
  const resolved = await loadConfig(join(project, "experiments", `${box.name}.ts`));
  // One model: the box routes every call to the model its env file names.
  const config = { ...resolved, model: (Array.isArray(resolved.model) ? resolved.model[0] : resolved.model) ?? "gpt-6-luna" };
  const { fixtures, errors } = loadAllFixtures(join(project, "evals"));
  for (const error of errors) console.error(error.message);
  const selected = process.argv.slice(2);
  const chosen = selected.length ? fixtures.filter((fixture) => selected.includes(fixture.name)) : fixtures;
  if (!chosen.length) throw new Error(`No ${box.displayName} evals selected`);
  console.log(`Running ${chosen.map((fixture) => fixture.name).join(", ")}; watch the box at http://outfitter.localhost:${port}`);
  const results = await runExperiment({
    config,
    fixtures: chosen,
    apiKey: env.OPENAI_API_KEY ?? "",
    resultsDir: join(project, "results"),
    experimentName: box.name,
    onProgress: (event) => console.log(JSON.stringify(event).slice(0, 300)),
  });
  console.log(formatResultsTable(results));
  process.exitCode = results.evals.every((entry) => entry.passedRuns === entry.totalRuns) ? 0 : 1;
}
