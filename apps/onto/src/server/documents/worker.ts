import type { AgentDatabase } from "@ai-outfitter/app-sdk/agent-store";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import {
  scheduleInput,
  taskInvocation,
  type WorkflowHost,
} from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { documentHost, scopeOf } from "./integration";
import {
  complete,
  errorText,
  getDocumentDefinition,
  lease,
  maxAttempts,
  readLive,
  retry,
} from "./service";
import { defaultContract, renderTemplate, validateSchema } from "./render";

export const documentWorkflow = "document-generation";
const answer = z.strictObject({
  title: z.string().min(1).max(200),
  markdown: z.string().max(32000),
});
const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "markdown"],
  properties: {
    title: { type: "string", maxLength: 200 },
    markdown: { type: "string", maxLength: 32000 },
  },
};
/** One scheduled run processes one current job, keeping its reserved workflow identity. */
export async function processDocumentWork(
  db: AgentDatabase,
  identity: AppIdentity,
  host: WorkflowHost<"schedule" | "interactive">,
  phase: "schedule" | "interactive",
  raw: unknown,
) {
  const manual = phase === "interactive" ? taskInvocation.parse(raw) : null;
  if (
    manual &&
    !z.string().min(1).max(128).safeParse(manual.inputs.jobId).success
  )
    throw new Response("Document task requires a job ID", { status: 400 });
  const input = manual
    ? {
        runId: manual.runId,
        schedule: { workflowId: manual.task, inputs: manual.inputs },
      }
    : scheduleInput.parse(raw);
  if (input.schedule.workflowId !== documentWorkflow || !identity.canEdit)
    throw new Response("Document workflow and editor authority required", {
      status: 403,
    });
  const scope = scopeOf(identity);
  const now = Date.now();
  const priorRun = (
    await db.query({
      sql: "SELECT job_id FROM document_runs WHERE owner=? AND run_id=?",
      params: [scope.owner, input.runId],
    })
  )[0];
  if (manual && priorRun && priorRun.job_id !== manual.inputs.jobId)
    throw new Response("Document run conflicts with its job", { status: 409 });
  await db.batch([
    {
      sql: `UPDATE document_jobs SET state='failed',error='Generation lease expired after maximum attempts',lease_token=NULL,lease_until=NULL WHERE owner=? AND state='leased' AND lease_until<=? AND attempts>=${maxAttempts}`,
      params: [scope.owner, now],
    },
  ]);
  const selected = priorRun?.job_id ?? manual?.inputs.jobId ?? null;
  let jobs = await db.query({
    sql: `SELECT j.id,j.document_id FROM document_jobs j JOIN document_heads h ON h.owner=j.owner AND h.id=j.document_id AND h.latest_job=j.id WHERE j.owner=? AND j.attempts<${maxAttempts} AND (j.state IN ('queued','retry') OR (j.state='leased' AND j.lease_until<=?)) AND (? IS NULL OR j.id=?) ORDER BY j.rowid LIMIT 1`,
    params: [scope.owner, now, selected, selected],
  });
  // One refresh per scheduled occurrence, only when the ordinary queue is empty.
  // A run-derived job ID makes replay of the same occurrence idempotent.
  if (!manual && !priorRun && jobs.length === 0) {
    const jobId = `schedule:${input.runId}`;
    const prior = await db.query({
      sql: "SELECT id FROM document_jobs WHERE owner=? AND id=?",
      params: [scope.owner, jobId],
    });
    if (!prior.length) {
      const candidates = await db.query({
        sql: "SELECT h.id FROM document_heads h JOIN document_definitions d ON d.owner=h.owner AND d.id=h.definition_id AND d.version=h.definition_version LEFT JOIN document_jobs j ON j.owner=h.owner AND j.id=h.latest_job WHERE h.owner=? AND json_extract(d.definition,'$.contract.refresh')='schedule' AND (j.id IS NULL OR j.state='complete') ORDER BY h.revision,h.id LIMIT 1",
        params: [scope.owner],
      });
      if (candidates[0]) {
        const documentId = String(candidates[0].id),
          guardId = crypto.randomUUID();
        try {
          await db.batch([
            {
              sql: "INSERT INTO document_guards(id,ok) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM document_heads h LEFT JOIN document_jobs j ON j.owner=h.owner AND j.id=h.latest_job WHERE h.owner=? AND h.id=? AND (j.id IS NULL OR j.state='complete')) THEN 1 ELSE 0 END)",
              params: [guardId, scope.owner, documentId],
            },
            {
              sql: "INSERT INTO document_jobs(owner,id,document_id,definition_version,base_revision,state) SELECT owner,?,id,definition_version,revision,'queued' FROM document_heads WHERE owner=? AND id=?",
              params: [jobId, scope.owner, documentId],
            },
            {
              sql: "UPDATE document_heads SET latest_job=? WHERE owner=? AND id=?",
              params: [jobId, scope.owner, documentId],
            },
            {
              sql: "DELETE FROM document_guards WHERE id=?",
              params: [guardId],
            },
          ]);
        } catch {
          /* concurrent occurrence claimed the same head */
        }
      }
    }
    jobs = await db.query({
      sql: `SELECT j.id,j.document_id FROM document_jobs j JOIN document_heads h ON h.owner=j.owner AND h.id=j.document_id AND h.latest_job=j.id WHERE j.owner=? AND j.id=? AND j.attempts<${maxAttempts} AND (j.state IN ('queued','retry') OR (j.state='leased' AND j.lease_until<=?))`,
      params: [scope.owner, jobId, now],
    });
  }
  const job = jobs[0];
  if (!job) return { completed: 0, failed: 0, started: false };
  const jobId = String(job.id),
    documentId = String(job.document_id),
    token = crypto.randomUUID();
  try {
    await db.batch([
      {
        sql: "INSERT INTO document_runs(owner,run_id,job_id) VALUES(?,?,?) ON CONFLICT(owner,run_id) DO NOTHING",
        params: [scope.owner, input.runId, jobId],
      },
    ]);
  } catch {
    return { completed: 0, failed: 0, started: false };
  }
  const run = (
    await db.query({
      sql: "SELECT job_id FROM document_runs WHERE owner=? AND run_id=?",
      params: [scope.owner, input.runId],
    })
  )[0];
  if (run?.job_id !== jobId) return { completed: 0, failed: 0, started: false };
  try {
    await lease(db, scope, jobId, token, Date.now(), 120_000);
  } catch {
    return { completed: 0, failed: 0, started: false };
  }
  // task.start already created the manual run; schedule owns a reserved run ID.
  let started = Boolean(manual);
  try {
    const declared = await getDocumentDefinition(db, scope, documentId),
      contract = declared.definition.contract ?? defaultContract;
    if (!validateSchema(contract.inputSchema, contract.params))
      throw new Error("Definition input does not satisfy supported schema");
    const capture = await readLive(
      db,
      scope,
      documentId,
      documentHost(host, phase),
    );
    if (!capture.complete) throw new Error("Source capture incomplete");
    if (!manual) {
      await host.call("workflow.start", {
        workflow: documentWorkflow,
        id: input.runId,
        inputs: input.schedule.inputs,
      });
      started = true;
    }
    const template = renderTemplate(contract, capture);
    let rendered = template;
    if (contract.rendering.mode !== "template") {
      const generated = await host.call("inference.generate", {
        runId: input.runId,
        step: "render",
        instructions:
          "Produce a concise document using only the supplied captured evidence. Do not invent facts or approvals.",
        data: JSON.parse(
          JSON.stringify({
            contract,
            capture,
            template:
              contract.rendering.mode === "combined" ? template : undefined,
          }),
        ),
        schema: answerSchema,
      });
      rendered = answer.parse(generated.output);
    }
    if (!validateSchema(contract.outputSchema, rendered))
      throw new Error("Generated output does not satisfy definition schema");
    await host.call("workflow.collect", {
      runId: input.runId,
      slot: "render.outputs.document",
      value: rendered,
    });
    await complete(
      db,
      scope,
      jobId,
      token,
      Date.now(),
      {
        document: rendered,
        provenance: {
          definition: { id: declared.id, version: declared.version },
          queries: declared.definition.sources,
          params: contract.params,
          period: contract.period ?? null,
          observedAt: capture.sources.map((s) => s.observedAt),
          workflowRun: input.runId,
          jobId,
        },
      },
      capture,
    );
    return { completed: 1, failed: 0, started: true };
  } catch (error) {
    try {
      await retry(
        db,
        scope,
        jobId,
        token,
        Date.now(),
        errorText(error),
      );
    } catch {
      /* expired or superseded lease */
    }
    return { completed: 0, failed: 1, started };
  }
}

/** Public wrappers accept only the trusted platform phase envelopes. */
export async function processDocumentSchedule(
  db: AgentDatabase,
  identity: AppIdentity,
  host: WorkflowHost<"schedule">,
  phase: string,
  raw: unknown,
) {
  if (phase !== "schedule")
    throw new Response("Document generation requires the schedule phase", {
      status: 403,
    });
  return processDocumentWork(db, identity, host, "schedule", raw);
}
export async function processDocumentTask(
  db: AgentDatabase,
  identity: AppIdentity,
  host: WorkflowHost<"interactive">,
  raw: unknown,
) {
  const result = await processDocumentWork(
    db,
    identity,
    host,
    "interactive",
    raw,
  );
  return {
    completed: result.completed,
    failed: result.failed,
    started: result.started,
  };
}
