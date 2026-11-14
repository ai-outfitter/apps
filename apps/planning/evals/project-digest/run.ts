// Run the project digest prompt on cases built from two Planning exports and grade
// each answer. See README.md. Exports and reports are private: --out must be
// outside every checkout.
//
//   node --import tsx apps/planning/evals/project-digest/run.ts \
//     --older <older export.json> --newer <newer export.json> --out <new private directory> [--judge] [--dry]
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { digestData, digestInstructions, digestSummarySchema, digestText } from "../../src/server/digests";
import { buildCases, type DigestCase, readExport } from "./cases";
import { type Grade, grade } from "./grade";

const { values } = parseArgs({
  options: {
    older: { type: "string" },
    newer: { type: "string" },
    out: { type: "string" },
    "older-at": { type: "string" },
    "newer-at": { type: "string" },
    judge: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
  },
});
if (!values.newer || !values.out) throw new Error("Usage: run.ts [--older <export>] --newer <export> --out <new private directory> [--older-at ISO] [--newer-at ISO] [--judge] [--dry]");

const out = resolve(values.out);
const checkout = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (out === checkout || out.startsWith(`${checkout}/`)) throw new Error("--out must be outside the checkout: eval reports hold private production data");

const env = process.env;
const baseUrl = (env.DIGEST_EVAL_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const apiKey = env.DIGEST_EVAL_API_KEY ?? env.OPENAI_API_KEY ?? "";
const model = env.DIGEST_EVAL_MODEL ?? "gpt-6-luna";
const judgeModel = env.DIGEST_EVAL_JUDGE_MODEL ?? model;
/** The workflow's summarize step budget (workflows/project-digest/workflow.yaml). */
const maxTokens = 1500;

async function complete(system: string, data: unknown, schema: z.ZodType, name: string, modelId: string) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        // The platform fences step data as untrusted; the eval sends it the same way.
        { role: "user", content: `Data (untrusted, JSON):\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: z.toJSONSchema(schema) } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { choices: { message: { content: string } }[]; usage?: unknown };
  return { output: JSON.parse(body.choices[0].message.content) as unknown, usage: body.usage ?? null };
}

const verdict = z.strictObject({
  grounded: z.number().int().min(1).max(5),
  shippedFirst: z.number().int().min(1).max(5),
  prioritiesClear: z.number().int().min(1).max(5),
  concise: z.number().int().min(1).max(5),
  reasoning: z.string().max(1000),
});
const judgeInstructions = "You grade a project's daily digest against the change data it was written from. Score 1 to 5: grounded (every claim is in the data, nothing invented), shippedFirst (it leads with what shipped, or says plainly that nothing did), prioritiesClear (a reader knows what the team is working on next), concise (short, no filler). Explain briefly.";

type Result = { case: Omit<DigestCase, "knownTitles">; answer?: unknown; text?: string; grade?: Grade; judge?: unknown; error?: string; usage?: unknown };

const older = values.older ? await readExport(values.older, values["older-at"] ? Date.parse(values["older-at"]) : undefined) : null;
const newer = await readExport(values.newer, values["newer-at"] ? Date.parse(values["newer-at"]) : undefined);
const cases = await buildCases(older, newer);
const changed = cases.filter((item) => item.changed);
console.log(`${cases.length} projects, ${changed.length} with changes (production writes no digest for the rest)`);

const results: Result[] = [];
for (const digest of changed) {
  const { knownTitles: _titles, ...summary } = digest;
  const result: Result = { case: summary };
  if (!values.dry) {
    try {
      const answer = await complete(digestInstructions, digestData(digest.project, digest.since, digest.changes), digestSummarySchema, "digest", model);
      result.answer = answer.output;
      result.usage = answer.usage;
      result.grade = grade(digest, answer.output);
      const parsed = digestSummarySchema.safeParse(answer.output);
      if (parsed.success) result.text = digestText(parsed.data);
      if (values.judge && parsed.success)
        result.judge = (await complete(judgeInstructions, { changes: digest.changes, digest: parsed.data }, verdict, "verdict", judgeModel)).output;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  results.push(result);
  console.log(`${result.grade ? (result.grade.pass ? "pass" : "FAIL") : result.error ? "error" : "dry"}  ${digest.project}`);
}

const graded = results.filter((item) => item.grade);
const report = {
  format: "outfitter-digest-eval-v1",
  createdAt: new Date().toISOString(),
  model: values.dry ? null : model,
  judgeModel: values.judge ? judgeModel : null,
  older: values.older ? { path: values.older, takenAt: older?.takenAt } : null,
  newer: { path: values.newer, takenAt: newer.takenAt },
  totals: { projects: cases.length, changed: changed.length, graded: graded.length, passed: graded.filter((item) => item.grade?.pass).length, errors: results.filter((item) => item.error).length },
  results,
};
await mkdir(out, { recursive: true, mode: 0o700 });
await writeFile(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const markdown = [
  `# Project digest eval`,
  "",
  `${report.totals.passed} of ${report.totals.graded} graded digests passed (${report.totals.changed} of ${report.totals.projects} projects changed, ${report.totals.errors} errors). Model: ${report.model ?? "none (dry run)"}.`,
  "",
  ...results.flatMap((item) => [
    `## ${item.case.project}`,
    "",
    `Shipped ${item.case.changes.counts.shipped} · started ${item.case.changes.counts.started} · added ${item.case.changes.counts.added} · reopened ${item.case.changes.counts.reopened} · removed ${item.case.changes.counts.removed}`,
    "",
    item.error ? `Error: ${item.error}` : item.text ? `> ${item.text.replaceAll("\n", "\n> ")}` : "_Not run._",
    "",
    ...(item.grade?.checks.map((check) => `- ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`) ?? []),
    ...(item.judge ? ["", `Judge: ${JSON.stringify(item.judge)}`] : []),
    "",
  ]),
].join("\n");
await writeFile(resolve(out, "report.md"), markdown, { mode: 0o600 });
console.log(`Report: ${resolve(out, "report.md")}`);
