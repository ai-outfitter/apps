import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { registerAgent, runExperiment, type EvalFixture } from "@vercel/agent-eval";
import { readOnlyAgent } from "../../../../box/eval/read-only-agent.mjs";
import { grade } from "./grade";
import { fixtures, type FixtureId } from "./fixtures";

const suite = dirname(fileURLToPath(import.meta.url));
const configName = "workshop-motion-spark";
const model = "GLM-5.3-Flash-EXL3";
const base = process.env.SPARK_BASE_URL;
const authorization = process.env.SPARK_AUTHORIZATION ?? "";
const output = process.argv[2];
if (!base || !output || (authorization && !/^Bearer \S+$/.test(authorization))) {
  throw Error("Set SPARK_BASE_URL and provide a receipt output path. SPARK_AUTHORIZATION accepts Bearer credentials.");
}
const endpoint = new URL(base);
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw Error("Expected an HTTP(S) Spark API URL without credentials, query or fragment");
}

endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/chat/completions";
const limits = { modelCalls: 1, toolCalls: 0, tokensPerCall: 4096, temperature: 0, seed: 42 };
type AdapterReceipt = {
  inputs: { fixture: FixtureId };
  initialMessages: unknown;
  modelRevision: string | null;
  startedAt: string;
  limits: typeof limits;
  wallMs: number;
  modelCalls: number;
  toolCalls: number;
  turns: { model: string; fingerprint?: string; finishReason?: string }[];
  usage?: unknown;
  output?: string;
  grade?: unknown;
  error?: string;
};
const receipts: AdapterReceipt[] = [];
function digest(data: string) {
  return createHash("sha256").update(data).digest("hex");
}
const cases: EvalFixture[] = await Promise.all(Object.keys(fixtures).map(async (name) => {
  const path = join(suite, "evals", name);
  return { name, path, prompt: await readFile(join(path, "PROMPT.md"), "utf8"), isModule: true };
}));

registerAgent(readOnlyAgent({
  name: configName, model, endpoint, limits, receipts, modelRevision: null,
  async prepare(fixturePath: string, prompt: string) {
    const id = basename(fixturePath) as FixtureId;
    if (!Object.hasOwn(fixtures, id)) throw Error("Unknown motion fixture");
    const fixture = fixtures[id];
    const specification = JSON.stringify({
      durationSeconds: fixture.duration, playback: fixture.playback,
      parts: fixture.parts.map(({ name, axis }) => ({ name, joint: axis ?? "fixed" })),
    });
    const instructions = [
      "Author a Workshop motion program for the synthetic assembly described by the user.",
      'Return JSON only with keys "tracks", "couplings", "handoffs".',
      'Tracks are [{"part":"name","keys":[{"time":0,"value":0},{"time":1,"value":10}]}]. Keys are linearly interpolated. Supply at least two keys per authored track. Omit fixed and coupled follower parts from tracks.',
      'Couplings are [{"driver":"name","follower":"name","ratio":1}]. Follower value equals driver value times ratio.',
      'Handoffs are [{"time":1,"prop":"name","carrier":"name"}]. Use null carrier to release in place.',
      "Use degrees for rotation, millimeters for travel, seconds for time, and exact part names. Use empty arrays where unused.",
    ].join(" ");
    return {
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: prompt + "\nAssembly: " + specification },
      ],
      tools: [], execute() { throw Error("Tool calls are disabled"); },
      grade(content: string) {
        try { return grade(id, JSON.parse(content)); }
        catch { return { passed: false, error: "Response was not valid JSON" }; }
      },
      inputs: { fixture: id, promptSha256: digest(prompt), specificationSha256: digest(specification) },
    };
  },
}));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dependencyFiles = [
  "box/eval/read-only-agent.mjs",
  "apps/workshop/src/lib/assembly.ts",
  "apps/workshop/src/lib/operation-schema.ts",
  "apps/workshop/src/lib/operation-program.ts",
  "apps/workshop/src/lib/installed-operations.ts",
];
const dependencySha256 = Object.fromEntries(await Promise.all(dependencyFiles.map(async (name) =>
  [name, digest(await readFile(join(root, name), "utf8"))])));
const sourceSha256 = Object.fromEntries(await Promise.all(["fixtures.ts", "grade.ts", "run.ts"].map(async (name) =>
  [name, digest(await readFile(join(suite, name), "utf8"))])));
const resultsDir = await mkdtemp(join(tmpdir(), "workshop-motion-eval-"));
try {
  const results = await runExperiment({
    config: { agent: configName, model, runs: 1, timeout: 240 },
    fixtures: cases, apiKey: authorization.slice(7), experimentName: configName, resultsDir,
  });
  for (const summary of results.evals) console.log(summary.name, summary.passedRuns + "/" + summary.totalRuns);
  process.exitCode = receipts.length === cases.length
    && results.evals.every((entry) => entry.totalRuns === 1 && entry.passedRuns === 1) ? 0 : 1;
} finally {
  const recorded = receipts.map((receipt) => {
    const { inputs, initialMessages, modelRevision, startedAt, limits, wallMs, modelCalls,
      toolCalls, usage, output, grade, error } = receipt;
    const turn = receipt.turns[0];
    return { inputs, initialMessages, modelRevision, startedAt, limits, wallMs, modelCalls, toolCalls,
      observedModel: turn?.model, providerFingerprint: turn?.fingerprint, finishReason: turn?.finishReason,
      usage, output, grade, error };
  }).sort((a, b) => a.inputs.fixture.localeCompare(b.inputs.fixture));
  try {
    await writeFile(output, JSON.stringify({ model, sourceSha256, dependencySha256, receipts: recorded }, null, 2) + "\n",
      { mode: 0o600 });
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
}
