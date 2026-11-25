// Summarize any pair of replay reports. Raw reports contain the exact fixture
// evidence, rendered answers, write provenance and provider receipts.
import { readFile, writeFile } from "node:fs/promises";

const [flagOrPath, ...remaining] = process.argv.slice(2);
const regrade = flagOrPath === "--regrade";
const paths = regrade ? remaining : [flagOrPath, ...remaining];
if (!paths[0] || paths.length !== 2) throw new Error("Usage: node --import tsx issue-273-evidence.mjs [--regrade] <baseline.json> <candidate.json>");
const [baseline, candidate] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8"))));
if (regrade) {
  const { gradeIssue273 } = await import("./issue-273-grade.ts");
  const { chicagoFallback, oceanMorning } = await import("./issue-273-fixtures.ts");
  for (const [index, report] of [baseline, candidate].entries()) {
    for (const item of report.cases) for (const run of item.runs) {
      run.checks = gradeIssue273(run, run.id === "nov01-chicago-dst" ? chicagoFallback : oceanMorning, report.mode === "transport-stub");
    }
    await writeFile(paths[index], JSON.stringify(report, null, 2) + "\n");
  }
}
const passCount = checks => `${checks.filter(check => check.pass).length}/${checks.length}`;
const allProviderCalls = report => [
  ...Object.values(report.onto).flatMap(onto => onto.provider),
  ...report.cases.flatMap(item => item.runs.flatMap(run => run.provider)),
];
for (const [label, report] of [["Baseline", baseline], ["Candidate", candidate]]) {
  const calls = allProviderCalls(report);
  const accepted = calls.filter(call => call.status === 200 && call.responseId && !call.error);
  const total = calls.reduce((sum, call) => sum + call.seconds, 0);
  console.log(`${label} \`${report.revision}\`. ${report.mode}. ${report.model ?? "No model"}. ${accepted.length}/${calls.length} parseable provider responses in ${total.toFixed(1)} seconds of client time.`);
}
console.log("\n| Case and stage | Baseline | Candidate |\n| --- | ---: | ---: |");
const baselineRuns = baseline.cases.flatMap(item => item.runs);
const candidateRuns = candidate.cases.flatMap(item => item.runs);
const rows = [
  ...Object.keys(candidate.onto).map(name => [`Onto ${name}`, baseline.onto[name], candidate.onto[name]]),
  ...candidateRuns.map(run => [`${run.id} / ${run.stage}`, baselineRuns.find(item => item.id === run.id && item.stage === run.stage), run]),
];
for (const [name, before, after] of rows) {
  console.log(`| \`${name}\` | ${before?.checks ? passCount(before.checks) : "error"} | ${after?.checks ? passCount(after.checks) : "error"} |`);
}
console.log("\n### Failed checks");
for (const [name, before, after] of rows) {
  for (const [label, row] of [["Baseline", before], ["Candidate", after]]) {
    const messages = row?.checks?.filter(check => !check.pass).map(check => `${check.name}. ${check.detail}`) ?? [row?.error ?? "Missing result"];
    if (messages.length) console.log(`\n- ${label}, \`${name}\`. ${messages.join(" ")}`);
  }
}
