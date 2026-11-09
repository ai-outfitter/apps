// The experiments record: one committed folder per box eval run under
// apps/<app>/box/evals/experiments/runs/<run>, with an index across them, so
// runs on different models and dates stay comparable. Heavy artifacts (box
// log, sessions, repo bundle) stay in the ignored results/runs/<run>, and the
// box's own state in the run's volume (box/runs.mjs).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunRecord = {
  runId: string;
  eval: string;
  box: string;
  image: { ref: string; id?: string; created?: string };
  /** The apps checkout the eval ran from. */
  checkout?: string;
  model?: { provider: string; id: string };
  status: string;
  success: boolean;
  grade?: { passed: number; total: number };
  durationSeconds: number;
  metrics?: { wallSeconds?: number; modelSeconds?: number; modelCalls?: number; inputTokens?: number; outputTokens?: number;
    outputTokensPerSecond?: number; steps?: unknown[] };
  /** The named volume holding the box's state, while it is kept. */
  volume?: string;
  startedAt?: string;
  /** What happened, written by hand after the run. */
  notes?: string;
  /** EVAL.ts output; written beside the record as eval.txt. */
  evalOutput?: string;
  /** The box's run-result document; written beside the record as result.json. */
  result?: unknown;
};

const stripColour = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Passed and total tests from a vitest report ("Tests  3 failed | 3 passed (6)"). */
export function gradeCounts(output: string) {
  const line = stripColour(output).split("\n").find((entry) => /^\s*Tests\s/.test(entry));
  const total = Number(line?.match(/\((\d+)\)/)?.[1]);
  if (!line || !Number.isFinite(total)) return undefined;
  return { passed: Number(line.match(/(\d+) passed/)?.[1] ?? 0), total };
}

/** Writes one run's record and rebuilds the index of every run. */
export function writeRunRecord(runs: string, record: RunRecord) {
  const { evalOutput, result, ...summary } = record;
  const directory = join(runs, record.runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (evalOutput) writeFileSync(join(directory, "eval.txt"), stripColour(evalOutput));
  if (result) writeFileSync(join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeRunIndex(runs);
}

/** runs/README.md: every recorded run, newest first. */
export function writeRunIndex(runs: string) {
  const records = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runs, entry.name, "run.json")))
    .map((entry) => JSON.parse(readFileSync(join(runs, entry.name, "run.json"), "utf8")) as RunRecord)
    .sort((a, b) => b.runId.localeCompare(a.runId));
  const value = (number?: number) => (number === undefined ? "–" : String(Math.round(number * 10) / 10));
  const tokens = (number?: number) => (number === undefined ? "–" : number >= 1e6 ? `${Math.round(number / 1e5) / 10}M` : `${Math.round(number / 100) / 10}k`);
  const rows = records.map((run) => `| [${run.runId}](${run.runId}/run.json) | ${run.model ? `${run.model.provider} / ${run.model.id}` : "–"} | ${run.status} | ${
    run.grade ? `${run.grade.passed}/${run.grade.total}` : "–"} | ${run.success ? "pass" : "fail"} | ${value(run.metrics?.wallSeconds ?? run.durationSeconds)} | ${
    value(run.metrics?.modelCalls)} | ${tokens(run.metrics?.inputTokens)} | ${tokens(run.metrics?.outputTokens)} | ${run.volume ? `\`${run.volume}\`` : "–"} |`);
  writeFileSync(join(runs, "README.md"), [
    "# Recorded runs",
    "",
    "Written by the box eval harness after every run (`box/eval/experiments.ts`); newest first.",
    "A run's volume holds its box state until removed: `node box/runs.mjs open <volume>` reopens it.",
    "",
    "| run | model | box result | grade | eval | wall s | calls | tokens in | tokens out | volume |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n"));
}
