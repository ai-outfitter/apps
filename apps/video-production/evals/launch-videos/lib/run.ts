// What the platform's eval runner hands EVAL.ts: the run file it names in
// OUTFITTER_EVAL_RUN (the member's prompt, the agent's answer, every MCP call
// and Onto's tables before and after), and a judge on the run's judge model.
// The runner itself stays in the platform (webapp evals/outfitter/lib/run-fixture.ts).
import { readFileSync } from "node:fs";

export type Row = Record<string, unknown>;
export type McpCall = { tool: string; arguments: Record<string, unknown>; responseBytes: number; elapsedMs: number; isError: boolean };
export type Run = {
  prompt: string;
  answer: string;
  calls: McpCall[];
  pointAEqualsPointB: boolean;
  /** Onto's graph_batches, graph_batch_operations, graph_types, graph_nodes, graph_edges and onto_review_jobs. `before` keeps id and name only. */
  onto: { before: Record<string, Row[]>; after: Record<string, Row[]> };
  /** Model spec: luna, openai:<model> or spark[:<model>]. */
  judge: string;
};

export function run(): Run {
  const path = process.env.OUTFITTER_EVAL_RUN;
  if (!path) throw new Error("EVAL.ts runs only inside an Outfitter eval run");
  return JSON.parse(readFileSync(path, "utf8")) as Run;
}

/** The judge's endpoint, as the runner resolves model specs. Credentials come from the environment only. */
async function endpoint(spec: string, env = process.env) {
  const [name, explicit] = (spec === "luna" ? "openai:gpt-6-luna" : spec).split(/:(.*)/s, 2) as [string, string | undefined];
  if (name === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    return { url: (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""), model: explicit || "gpt-6-luna", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } };
  }
  if (name === "spark") {
    const authorization = env.SPARK_AUTHORIZATION ?? (env.SPARK_API_KEY ? `Bearer ${env.SPARK_API_KEY}` : undefined);
    const model = explicit || env.SPARK_MODEL;
    if (!model) throw new Error("Name the Spark model as spark:<model> or SPARK_MODEL");
    return { url: (env.SPARK_BASE_URL ?? "http://spark-f838:8000/v1").replace(/\/$/, ""), model, headers: authorization ? { authorization } : ({} as Record<string, string>) };
  }
  throw new Error(`Unknown model "${spec}": use luna, openai:<model> or spark[:<model>]`);
}

/** Ask the judge model whether the run meets a criterion. */
export async function judge(criterion: string, context: string): Promise<{ pass: boolean; reason: string }> {
  const { prompt, answer, judge: spec } = run();
  const target = await endpoint(spec);
  const response = await fetch(`${target.url}/chat/completions`, {
    method: "POST",
    headers: { ...target.headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: "system", content: 'You grade an AI agent\'s work. Reply with JSON only: {"pass": true|false, "reason": "<one sentence>"}.' },
        { role: "user", content: `Question the member asked:\n${prompt}\n\nFacts the answer must match:\n${context}\n\nCriterion:\n${criterion}\n\nAgent's answer:\n${answer}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Judge answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const text = ((await response.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { pass: boolean; reason: string };
}
