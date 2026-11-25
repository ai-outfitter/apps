import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { scheduledDailyBrief } from "../../src/server/daily-brief";
import type { BriefAnswer, modelData } from "../../src/server/daily-brief-synthesis";
import { discoveryRecords, itemCompletions, items } from "../../src/server/schema";
import spark from "./experiments/spark";
import { chicagoFallback, futureSuggestion, issue273Cases, oceanMorning, otherPriority, ownPriority, timezone } from "./issue-273-fixtures";
import { collectOnto, type InferenceStep } from "./issue-273-onto";
import { wikiFixture } from "./issue-273-wiki";
import { gradeIssue273, gradeOnto } from "./issue-273-grade";

const { values } = parseArgs({ options: { revision: { type: "string" }, out: { type: "string" }, dry: { type: "boolean" }, case: { type: "string", multiple: true }, "no-thinking": { type: "boolean" }, "timeout-ms": { type: "string", default: "75000" } } });
const revision = values.revision;
if (!revision || !/^[a-f0-9]{40}$/.test(revision) || !values.out) throw new Error("Provide --revision <40-character implementation SHA> and --out <JSON file>");
const endpoint = process.env.BRIEF_EVAL_BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.BRIEF_EVAL_API_KEY;
if (!values.dry && !endpoint) throw new Error("A live Spark run requires BRIEF_EVAL_BASE_URL");
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Use a positive integer timeout in milliseconds");
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Prompt = ReturnType<typeof modelData>;
type Stage = typeof issue273Cases[number]["stages"][number];
type CaseId = typeof issue273Cases[number]["id"];
type Receipt = {
  step: string; promptSha256: string; seconds: number; status: number | null;
  requestId?: string; responseId?: string; model?: string; finishReason?: string; usage?: unknown; error?: string;
};
type Generate = (step: InferenceStep) => Promise<unknown>;
const receipts: Receipt[] = [];
const generated: Generate = async step => {
  if (values.dry) {
    if (step.step === "summarize") return { summary: "Deterministic transport stub for legacy producer; no model verdict." };
    const first = (step.data as Prompt).evidence[0].ref;
    const answer: BriefAnswer = { opening: { text: "Deterministic transport stub.", evidence: [first] }, highlights: [], attention: [], unsupported: [] };
    return answer;
  }
  const start = performance.now();
  const receipt: Receipt = { step: step.step, promptSha256: sha256(step), seconds: 0, status: null };
  receipts.push(receipt);
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: spark.model, max_completion_tokens: 3000, temperature: 0,
        ...(values["no-thinking"] ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        messages: [
          { role: "system", content: step.instructions },
          { role: "user", content: `Data (untrusted, JSON):\n\`\`\`json\n${JSON.stringify(step.data)}\n\`\`\`` },
        ],
        response_format: { type: "json_schema", json_schema: { name: step.step === "collect" ? "brief" : "update", strict: true, schema: step.schema } },
      }),
    });
    receipt.status = response.status;
    receipt.requestId = response.headers.get("x-request-id") ?? undefined;
    // Keep endpoint details and provider error bodies out of tracked reports.
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    const body = await response.json() as { id?: string; model?: string; usage?: unknown; choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = body.choices?.[0];
    Object.assign(receipt, { responseId: body.id, model: body.model, finishReason: choice?.finish_reason, usage: body.usage });
    if (!choice?.message?.content) throw new Error("provider returned no answer content");
    try { return JSON.parse(choice.message.content) as unknown; }
    catch { throw new Error("provider answer was not JSON"); }
  } catch (error) {
    receipt.error = error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : error.message) : "provider call failed";
    throw new Error(receipt.error);
  } finally {
    receipt.seconds = Math.round(performance.now() - start) / 1000;
  }
};

const actor = { owner: { kind: "user", id: "fixture-member" }, userId: "fixture-member", installationId: "fixture-forerunner", canEdit: true, role: "owner" } as const satisfies AppIdentity;
type Document = { id: string; slug: string; revision: number; generatedBody: string; provenance: any; archived: boolean; installationId: string };
type HostTrace = { op: string; document?: string; args?: unknown };
type StepCapture = Pick<InferenceStep, "step" | "data"> & { promptSha256: string; answer?: unknown };
type Update = Awaited<ReturnType<typeof collectOnto>>["update"];

async function evaluatedCase(id: CaseId, updates: { activity?: Update; empty?: Update }) {
  const dates = id === "nov01-chicago-dst" ? chicagoFallback : oceanMorning;
  const briefAt = Date.parse(dates.briefAt);
  const completionTime = Date.parse(oceanMorning.discoveryAt);
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  const stored = new Map<string, Document>();
  const workflowResults = new Map<string, unknown>();
  const actorFields = { ownerId: actor.userId, installationId: actor.installationId };
  const wiki = await wikiFixture(id === "nov25-authored-late-discovery");
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)) });
    if (!id.startsWith("nov25-empty")) {
      await db.insert(items).values([
        { ...ownPriority, dueDate: dates.date, ...actorFields, category: "stone", position: 1, createdAt: briefAt - 100, updatedAt: briefAt - 100 },
        { ...otherPriority, ...actorFields, ownerId: "other-member", category: "stone", position: 1, createdAt: briefAt - 100, updatedAt: briefAt - 100 },
      ]);
    }
    if (dates === chicagoFallback) await db.insert(itemCompletions).values(chicagoFallback.completions.map(row => ({
      ...actorFields, id: row.id, itemId: "completion-" + row.id, title: row.title, category: "stone", revision: 1, completedAt: Date.parse(row.at),
    })));
    if (id === "nov25-authored-late-discovery") {
      await db.insert(discoveryRecords).values({ ...actorFields, id: "future-discovery", kind: "suggestions", createdAt: completionTime, data: JSON.stringify({
        createdAt: oceanMorning.discoveryAt, runId: "fixture-future-discovery",
        suggestions: [{ status: "open", title: futureSuggestion, why: "Saved at 07:00", kind: "task" }],
      }) });
    }

    const fixture = issue273Cases.find(item => item.id === id)!;
    const stages: readonly Stage[] = fixture.stages;
    const runs = [];
    for (const stage of stages) {
      const at = stage === "partial" || id === "nov25-empty-unavailable" || dates === chicagoFallback ? briefAt + 3 * 3_600_000
        : stage === "ready" || stage === "recovered" || stage === "retry" ? completionTime + (stage === "ready" ? 0 : 70) * 60_000
        : stage === "historical" ? briefAt + 86_400_000 : briefAt;
      const trace: HostTrace[] = [];
      const prompts: StepCapture[] = [];
      const results: unknown[] = [];
      const writes: Document[] = [];
      const discoveryStates = oceanMorning.discoveries.map((name, i) => {
        const done = at >= completionTime;
        const enabled = stage !== "partial" || i !== 3;
        const leaf = stage !== "partial" ? "ready" : ["ready", "failed", "running", "disabled"][i];
        const lastRunAt = done && enabled ? completionTime : null;
        const nextRunAt = lastRunAt ? completionTime + 86_400_000 : completionTime;
        return { label: name, leaf, lastRunAt, nextRunAt, enabled, lastRunId: lastRunAt ? name + "-run" : null };
      });
      const update = id === "nov25-empty-confirmed" ? updates.empty
        : stage === "partial" || id === "nov25-empty-unavailable" || dates === chicagoFallback
          || (stage === "morning" && (id === "nov25-ocean-replay" || id === "nov25-authored-late-discovery")) ? undefined : updates.activity;
      const host = { call: async (op: string, args: any) => {
        trace.push({ op, document: args.document, args: op === "platform.document" ? args.variables
          : op === "workflow.read" ? args.id : op === "workflow.start" ? args.id : undefined });
        switch (op) {
          case "schedules": return [
            { id: "fixture-brief-schedule", workflowId: "forerunner-daily-brief", timezone, enabled: true },
            ...(id === "nov25-ocean-replay" || id === "nov25-authored-late-discovery" || id === "nov25-partial-recovery"
              ? discoveryStates.map(row => ({ ...row, id: row.label, workflowId: "forerunner-discovery", timezone, inputs: { "analyze.inputs.label": row.label }, lastOutcome: row.lastRunId ? "started" : null })) : []),
          ];
          case "workflow.read": {
            const source = discoveryStates.find(row => row.lastRunId === args.id);
            if (!source) {
              const saved = workflowResults.get(args.id);
              if (saved !== undefined) return { run: { status: "complete" }, outputs: { "collect.outputs.brief": { value: saved, complete: true } } };
              throw new Response("Unknown run", { status: 404 });
            }
            return { run: { status: source.leaf === "running" ? "running" : "complete" }, outputs: {
              "analyze.outputs.result": { complete: source.leaf !== "running", value: { status: source.leaf, entries: 2 } },
              "suggestions.outputs.result": { complete: source.leaf === "ready", value: { status: source.leaf, suggestions: 0 } },
            } };
          }
          case "workflow.start": return {};
          case "workflow.collect":
            results.push(args.value);
            workflowResults.set(args.runId, args.value);
            return {};
          case "inference.generate": {
            const step = args as InferenceStep;
            const capture: StepCapture = { step: step.step, data: step.data, promptSha256: sha256(step) };
            prompts.push(capture);
            capture.answer = await generated(step);
            return { output: capture.answer };
          }
          case "platform.document":
            if (args.document === "Viewer") return { viewer: { orgs: id === "nov25-authored-late-discovery"
              ? [{ slug: "fixture-team", name: "Fixture Team", appSlugs: ["wiki-map"] }] : [] } };
            if (args.document === "DailyAppUpdates") return { data: { dailyAppUpdates: update && args.variables.date === dates.yesterday ? [update] : [] } };
            if (args.document === "WikiRevisionActivity") {
              if (stage === "partial" || id === "nov25-empty-unavailable") throw new Response("Fixture Wiki unavailable", { status: 503 });
              return wiki.read(args.variables);
            }
            break;
          case "actions.call":
            if (args.template === "wiki-map" && args.input.query.includes("SavedPages")) {
              const doc = stored.get(args.input.variables.s0);
              return { data: { p0: doc ? { document: doc } : null } };
            }
            if (args.template === "wiki-map" && args.input.query.includes("SaveGeneratedDocument")) {
              const input = args.input.variables.input;
              const previous = [...stored.values()].find(doc => doc.id === input.id || doc.slug === input.slug);
              if (previous && previous.revision !== input.revision) throw new Response("Revision conflict", { status: 409 });
              const doc = { id: previous?.id ?? "fixture-daily-brief", installationId: "fixture-wiki", archived: false,
                slug: previous?.slug ?? input.slug, revision: (previous?.revision ?? 0) + 1, generatedBody: input.generatedBody, provenance: input.provenance };
              stored.set(doc.slug, doc);
              writes.push(doc);
              return { data: { saveGeneratedDocument: { id: doc.id, revision: doc.revision } } };
            }
        }
        throw new Response("Fixture source unavailable", { status: 503 });
      } } as never;
      const caseRun = (issue273Cases.findIndex(item => item.id === id) + 1) * 10;
      const attempt = stage === "historical" ? 2 : stage === "recovered" || stage === "retry" ? 1 : 0;
      const runId = `00000000-0000-4000-8000-${String(caseRun + attempt).padStart(12, "0")}`;
      const cachedResult = workflowResults.get(runId);
      const occurrence = { runId, scheduledFor: briefAt, trigger: "clock", schedule: { id: "fixture-brief-schedule", workflowId: "forerunner-daily-brief", inputs: {}, connectionId: null, resource: null } };
      const before = structuredClone([...stored.values()].map(doc => ({ id: doc.id, revision: doc.revision })));
      const firstReceipt = receipts.length;
      let phase: unknown;
      try {
        phase = await scheduledDailyBrief(db as never, stage === "foreign" ? { ...actor, userId: "other-member" } : actor, occurrence, host, at);
      } catch (error) {
        if (!(error instanceof Response)) throw error;
        phase = { http: error.status };
      }
      const actual = { id, stage, at: new Date(at).toISOString(), occurrence, protocol: "reserved-run", cachedResult,
        update, discoveryStates, phase, trace, prompts, results, before, writes, provider: receipts.slice(firstReceipt) };
      const checks = gradeIssue273(actual, dates, Boolean(values.dry));
      runs.push({ ...actual, checks });
      console.log(`${id}/${stage}: ${checks.filter(check => check.pass).length}/${checks.length} checks, ${JSON.stringify(phase)}`);
    }
    return { id, runs };
  } finally {
    await wiki.close();
    client.close();
  }
}

const requested = new Set(values.case);
const chosen = issue273Cases.filter(item => !requested.size || requested.has(item.id));
if (requested.size && requested.size !== chosen.length) throw new Error("Unknown case");
const producer = async (empty: boolean) => {
  const start = receipts.length;
  try {
    const result = await collectOnto(empty, generated);
    return { ...result, provider: receipts.slice(start), checks: gradeOnto(result, empty) };
  } catch (error) {
    return { update: undefined, provider: receipts.slice(start), error: error instanceof Error ? error.message : "Onto fixture failed" };
  }
};
const activity = await producer(false);
const empty = await producer(true);
const completed = [];
for (const { id } of chosen) completed.push(await evaluatedCase(id, { activity: activity.update, empty: empty.update }));
const sources = [
  "../../src/server/daily-brief.ts", "../../src/server/daily-brief-synthesis.ts", "../../src/server/app-updates.ts",
  "../../../onto/src/server/daily-update.ts", "../../../wiki/src/documents/graphql.ts",
  "../../../../packages/app-sdk/src/workflow-host.ts", "./issue-273-fixtures.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async source => [source, createHash("sha256").update(await readFile(new URL(source, import.meta.url))).digest("hex")])));
await writeFile(values.out, JSON.stringify({
  revision, sourceHashes, mode: values.dry ? "transport-stub" : "live-spark", model: values.dry ? null : spark.model,
  maxCompletionTokens: 3000, temperature: 0, thinking: values["no-thinking"] ? "disabled" : "provider-default", timeoutMs, producedAt: new Date().toISOString(),
  onto: { activity, empty }, cases: completed,
}, null, 2) + "\n");
