import { StepInference } from "@ai-outfitter/workflow-core/schema";
import { z } from "zod";
import type { AppMigration } from "./migrations";
import { strictStructuredResult } from "./structured-result";
import { inferenceRequest } from "./workflow-inference";
import { operations, type WorkflowHostResult, type WorkflowHostStub } from "./workflow-host";

// The workflow host of an app running standalone (docs/standalone-apps.md):
// what the platform answers for an installed app, answered by the app itself
// from its own database and one model endpoint. It covers the operations an
// app needs to run its own workflows (runs, their outputs, structured and image
// inference). Operations that reach other apps, connectors, residents or the
// platform's records answer 501 until a standalone host can serve them.

/** Per workflow, per step: its declared inference settings and output names. */
export type StandaloneWorkflows = Record<string, Record<string, { inference?: StepInference; outputs: string[] }>>;

/** What `outfitterApp()` hands the standalone middleware, read at build time. */
export type StandaloneOptions = {
  app: string;
  name: string;
  dev: boolean;
  migrations: AppMigration[];
  workflows: StandaloneWorkflows;
};

/** Parameterized SQL over the app's own database (D1, or libSQL in tests). */
export type StandaloneDatabase = {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
};

/** An OpenAI-compatible endpoint: chat completions for structured answers, images for concepts. */
export type StandaloneInference = {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  imageModel?: string;
  fetch?: typeof fetch;
};

export type StandaloneMember = { id: string; name: string; email: string };

export const standaloneRunsTable = "_outfitter_standalone_runs";
const runsTable = `CREATE TABLE IF NOT EXISTS ${standaloneRunsTable} (id TEXT PRIMARY KEY NOT NULL, workflowId TEXT NOT NULL, status TEXT NOT NULL, inputs TEXT NOT NULL, outputs TEXT NOT NULL, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL) STRICT`;

type Run = {
  id: string;
  workflowId: string;
  status: "running" | "complete" | "failed";
  inputs: Record<string, unknown>;
  outputs: Record<string, { value: unknown; complete: boolean }>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

const failure = (status: number, message: string): WorkflowHostResult => ({ ok: false, status, message });

function decode(row: Record<string, unknown>): Run {
  return {
    ...(row as Omit<Run, "inputs" | "outputs">),
    inputs: JSON.parse(String(row.inputs)),
    outputs: JSON.parse(String(row.outputs)),
  };
}

/** The app's own workflow host for one signed-in member. */
export function standaloneHost(options: {
  db: StandaloneDatabase;
  member: StandaloneMember;
  workflows: StandaloneWorkflows;
  inference: StandaloneInference;
  now?: () => number;
}): WorkflowHostStub {
  const { db, member, workflows, inference } = options;
  const now = options.now ?? Date.now;
  let ready: Promise<void> | undefined;
  const table = () => (ready ??= db.run(runsTable));

  async function run(id: string) {
    await table();
    const [row] = await db.all(`SELECT * FROM ${standaloneRunsTable} WHERE id = ?`, [id]);
    return row ? decode(row) : undefined;
  }

  /** Every declared output of every step, as `step.outputs.name`. */
  const slots = (workflowId: string) =>
    Object.entries(workflows[workflowId] ?? {}).flatMap(([step, { outputs }]) => outputs.map((name) => `${step}.outputs.${name}`));

  function readiness(current: Run) {
    const steps = Object.fromEntries(
      Object.entries(workflows[current.workflowId] ?? {}).map(([step, { outputs }]) => [
        step,
        outputs.every((name) => current.outputs[`${step}.outputs.${name}`]?.complete) ? "complete" : "waiting",
      ]),
    );
    return { run: current.status, steps };
  }

  const handlers: Record<string, (input: never) => Promise<unknown>> = {
    "identity.current": async () => member,

    "workflow.start": async (input: { workflow: string; id: string; inputs: Record<string, unknown> }) => {
      if (!workflows[input.workflow]) throw failure(404, `Workflow ${input.workflow} not found`);
      const existing = await run(input.id);
      if (existing) {
        if (existing.workflowId !== input.workflow || JSON.stringify(existing.inputs) !== JSON.stringify(input.inputs))
          throw failure(409, "A run with this id already exists with other inputs");
        return { id: existing.id, workflow: existing.workflowId, created: false };
      }
      const at = now();
      await db.run(
        `INSERT INTO ${standaloneRunsTable} (id, workflowId, status, inputs, outputs, createdBy, createdAt, updatedAt) VALUES (?, ?, 'running', ?, '{}', ?, ?, ?)`,
        [input.id, input.workflow, JSON.stringify(input.inputs), member.id, at, at],
      );
      return { id: input.id, workflow: input.workflow, created: true };
    },

    "workflow.read": async (input: { id: string }) => {
      const current = await run(input.id);
      if (!current) return null;
      const { inputs, outputs, ...summary } = current;
      return { run: { ...summary, visibility: "organization" }, inputs, outputs, readiness: readiness(current), attempts: [] };
    },

    "workflow.collect": async (input: { runId: string; slot: string; value: unknown; complete: boolean }) => {
      const current = await run(input.runId);
      if (!current) throw failure(404, "Workflow run not found");
      if (!slots(current.workflowId).includes(input.slot)) throw failure(400, `${input.slot} is not an output of ${current.workflowId}`);
      if (current.status !== "running") throw failure(409, "The run is not running");
      current.outputs[input.slot] = { value: input.value, complete: input.complete };
      if (slots(current.workflowId).every((slot) => current.outputs[slot]?.complete)) current.status = "complete";
      await db.run(`UPDATE ${standaloneRunsTable} SET outputs = ?, status = ?, updatedAt = ? WHERE id = ?`, [
        JSON.stringify(current.outputs),
        current.status,
        now(),
        current.id,
      ]);
      return readiness(current);
    },

    "workflow.activity": async (input: {
      slots: string[];
      workflows?: string[];
      statuses: string[];
      limit: number;
      steps: boolean;
      before?: { updatedAt: number; id: string };
    }) => {
      await table();
      const all = (await db.all(`SELECT * FROM ${standaloneRunsTable} ORDER BY updatedAt DESC, id DESC`)).map(decode);
      const matching = all.filter(
        (current) => (!input.workflows || input.workflows.includes(current.workflowId)) && input.statuses.includes(current.status),
      );
      const after = input.before
        ? matching.filter(
            (current) =>
              current.updatedAt < input.before!.updatedAt || (current.updatedAt === input.before!.updatedAt && current.id < input.before!.id),
          )
        : matching;
      return {
        total: matching.length,
        items: after.slice(0, input.limit).map((current) => ({
          id: current.id,
          workflowId: current.workflowId,
          status: current.status,
          createdBy: current.createdBy,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
          visibility: "organization",
          inputs: Object.fromEntries(input.slots.filter((slot) => slot in current.inputs).map((slot) => [slot, current.inputs[slot]])),
          ...(input.steps
            ? { completedSteps: Object.entries(readiness(current).steps).filter(([, state]) => state === "complete").map(([step]) => step) }
            : {}),
        })),
      };
    },

    "workflow.active": async (input: { slots: string[]; workflows?: string[] }) => {
      await table();
      const rows = (await db.all(`SELECT * FROM ${standaloneRunsTable} WHERE status = 'running' ORDER BY updatedAt DESC`)).map(decode);
      return rows
        .filter((current) => !input.workflows || input.workflows.includes(current.workflowId))
        .map((current) => ({
          id: current.id,
          workflowId: current.workflowId,
          inputs: Object.fromEntries(input.slots.filter((slot) => slot in current.inputs).map((slot) => [slot, current.inputs[slot]])),
        }));
    },

    "inference.generate": async (input: {
      runId: string;
      step?: string;
      instructions: string;
      data: unknown;
      schema: Record<string, unknown>;
    } & StepInference) => {
      const current = await run(input.runId);
      if (!current) throw failure(404, "Workflow run not found");
      if (current.status !== "running") throw failure(409, "Inference is for a running run");
      const declared = (input.step && workflows[current.workflowId]?.[input.step]?.inference) || {};
      const settings = {
        maxOutputTokens: declared.maxOutputTokens ?? input.maxOutputTokens ?? 1500,
        timeoutMs: declared.timeoutMs ?? input.timeoutMs ?? 60_000,
        reasoningEffort: declared.reasoningEffort ?? input.reasoningEffort,
      };
      return { output: await generate(inference, inferenceRequest(input.instructions, input.data, input.schema, settings)) };
    },

    "inference.image": async (input: { runId: string; prompt: string; size: string }) => {
      const current = await run(input.runId);
      if (!current) throw failure(404, "Workflow run not found");
      if (current.status !== "running") throw failure(409, "Inference is for a running run");
      return image(inference, input.prompt, input.size);
    },
  };

  return {
    async call(name, raw) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
      if (!handler || !Object.hasOwn(operations, name))
        return failure(501, `${name} is not available when this app runs standalone`);
      const parsed = operations[name as keyof typeof operations].input.safeParse(raw);
      if (!parsed.success) return failure(400, `Invalid ${name} input`);
      try {
        return { ok: true, value: await handler(parsed.data as never) };
      } catch (error) {
        if (error && typeof error === "object" && "ok" in error) return error as WorkflowHostResult;
        if (error instanceof Response) return failure(error.status, await error.text());
        throw error;
      }
    },
  };
}

function endpoint(inference: StandaloneInference, path: string, model: string | undefined, setting: string) {
  if (!inference.apiKey) throw failure(503, "Model calls need INFERENCE_API_KEY (and INFERENCE_BASE_URL for a provider other than OpenAI)");
  if (!model) throw failure(503, `Model calls need ${setting}`);
  return { url: `${inference.baseUrl.replace(/\/+$/, "")}${path}`, model, headers: { Authorization: `Bearer ${inference.apiKey}`, "Content-Type": "application/json" } };
}

async function providerJSON(inference: StandaloneInference, url: string, init: RequestInit, timeoutMs: number) {
  let response: Response;
  try {
    response = await (inference.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw failure(504, "The model did not answer in time");
    throw failure(502, "The model endpoint could not be reached");
  }
  // Never pass provider bodies on: they can echo prompts or keys.
  if (!response.ok) throw failure(502, `The model endpoint answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** One structured answer from an OpenAI-compatible chat completions endpoint, validated against the app's schema. */
async function generate(inference: StandaloneInference, request: ReturnType<typeof inferenceRequest>) {
  const { url, model, headers } = endpoint(inference, "/chat/completions", inference.model, "INFERENCE_MODEL");
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(request.schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    throw failure(400, "Unsupported result schema");
  }
  const body = await providerJSON(
    inference,
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: request.system }, ...request.messages],
        response_format: { type: "json_schema", json_schema: { name: "result", schema: request.schema, strict: strictStructuredResult(request.schema) } },
        max_completion_tokens: request.settings.maxOutputTokens,
        ...(request.settings.reasoningEffort ? { reasoning_effort: request.settings.reasoningEffort } : {}),
      }),
    },
    request.settings.timeoutMs,
  );
  const choice = (body.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  if (choice?.finish_reason === "length") throw failure(502, "The model reached its token limit before the answer was complete");
  let answer: unknown;
  try {
    answer = JSON.parse(choice?.message?.content ?? "");
  } catch {
    throw failure(502, "The model did not answer with JSON");
  }
  const parsed = validator.safeParse(answer);
  if (!parsed.success) throw failure(502, "The model's answer did not match the requested schema");
  return z.json().parse(parsed.data);
}

/** One PNG from an OpenAI-compatible images endpoint. */
async function image(inference: StandaloneInference, prompt: string, size: string) {
  const { url, model, headers } = endpoint(inference, "/images/generations", inference.imageModel, "IMAGE_MODEL");
  const body = await providerJSON(inference, url, { method: "POST", headers, body: JSON.stringify({ model, prompt, size, n: 1 }) }, 120_000);
  const base64 = (body.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
  if (!base64) throw failure(502, "The image model returned no image");
  return { contentType: "image/png", base64, model };
}
