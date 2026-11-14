/** Foundry's one front door for feature and bug requests: a typed brief, validated at the
 * boundary, becomes a GitHub issue and starts the configured workflow (submitWork). The
 * workflow's own triage node triages it. */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { entityRef } from "@ai-outfitter/app-sdk/entities";
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { checkRequestBrief, requestBrief } from "../box/contract";
import { submitWork, target, type IntakeContext } from "./intake";
import { issueRuns, startExistingFoundryIssue, submissionRepository } from "./workspace/workspaces";

/** The box's work-request brief (box/schemas/work-request.schema.json) plus where it goes. */
export const requestInput = z.strictObject({
  ...requestBrief,
  requestId: requestBrief.requestId.transform((value) => value.toLowerCase())
    .describe("Caller-generated ID. Reuse it to retry an identical request; changed content conflicts."),
  kind: requestBrief.kind.describe("feature: new or changed behavior. bug: existing behavior that is wrong; needs bug details."),
  target,
  context: z.array(entityRef.extend({ title: z.string().trim().max(200).optional() })).max(32).default([])
    .describe("Records the request relies on (stories, requirements, goals). Rendered as references; not resolved."),
}).superRefine(checkRequestBrief);

/** The issue description the request renders to; submitWork adds the criteria and attribution. */
export function requestDescription(input: z.output<typeof requestInput>) {
  const lines = [`**Kind:** ${input.kind}`, "", input.problem.trim()];
  if (input.bug) {
    lines.push("", "## Steps to reproduce", ...input.bug.stepsToReproduce.map((step, index) => `${index + 1}. ${step}`));
    lines.push("", "## Expected", input.bug.expected, "", "## Actual", input.bug.actual);
    if (input.bug.environment) lines.push("", "## Environment", input.bug.environment);
  }
  return lines.join("\n");
}

export const requestDescriptionText = "File a feature or bug request against a repository or Foundry project: kind, title, problem, acceptance criteria with ids, and for bugs steps to reproduce, expected and actual. Validated strictly against the work-request schema. Foundry opens the GitHub issue and starts its workflow, which triages, implements, reviews and merges. If execution is unavailable, returns the issue with run: null and execution details; the request is still recorded. Retry with the same requestId; changed content conflicts. Needs editor access.";

type RequestRow = { id: string; kind: string; title: string; fingerprint: string; issue_url: string | null };
export async function submitRequest(context: IntakeContext, input: z.output<typeof requestInput>) {
  requireEditor(context.identity);
  const db = context.db();
  const fingerprint = await sha256Hex(canonicalActionValue(input));
  await db.run(sql`INSERT INTO foundry_requests (id, created_by, kind, title, payload, fingerprint, created_at) VALUES (${input.requestId},${context.identity.userId},${input.kind},${input.title},${JSON.stringify(input)},${fingerprint},${Date.now()}) ON CONFLICT DO NOTHING`);
  const [row] = (await db.all(sql`SELECT * FROM foundry_requests WHERE id=${input.requestId} AND created_by=${context.identity.userId}`)) as RequestRow[];
  if (!row || row.fingerprint !== fingerprint) throw new Response("Request ID conflicts with existing input", { status: 409 });
  // submitWork is idempotent on requestId: a retry finds the issue and run an earlier attempt made.
  const submitted = await submitWork(context, {
    target: input.target, requestId: input.requestId, title: input.title,
    description: requestDescription(input), acceptanceCriteria: input.acceptanceCriteria.map((criterion) => `\`${criterion.id}\`: ${criterion.text}`), context: input.context,
  });
  await db.run(sql`UPDATE foundry_requests SET issue_url=${submitted.issue.url} WHERE id=${input.requestId} AND created_by=${context.identity.userId}`);
  return { id: input.requestId, kind: input.kind, ...submitted };
}

export const requestReadInput = z.strictObject({ids:z.array(z.uuid()).max(100).optional(),search:z.string().max(200).optional(),first:z.number().int().min(1).max(100).default(20),after:z.string().optional()});
export async function readRequests(context:IntakeContext,input:z.output<typeof requestReadInput>) {
  const rows = await context.db().all(sql`SELECT id,kind,title,issue_url FROM foundry_requests WHERE created_by=${context.identity.userId} AND id > ${input.after ?? ""} ${input.ids?.length ? sql`AND id IN (${sql.join(input.ids.map(id=>sql`${id}`),sql`, `)})` : sql``} ${input.search ? sql`AND title LIKE ${`%${input.search}%`}` : sql``} ORDER BY id LIMIT ${input.first+1}`) as RequestRow[];
  const nodes = rows.slice(0,input.first).map(row=>({id:row.id,kind:row.kind,title:row.title,issueUrl:row.issue_url}));
  return {nodes,pageInfo:{hasNextPage:rows.length>input.first,endCursor:rows.length>input.first ? nodes.at(-1)?.id : null}};
}

export const resumeInput = z.strictObject({
  requestId: z.uuid().transform((value) => value.toLowerCase()).describe("The request whose stopped run to start again."),
  resumeId: z.uuid().transform((value) => value.toLowerCase())
    .describe("Caller-generated ID for this restart. Reuse it to retry the same restart; a new one restarts again."),
});

/** Start a request's failed (or awaiting-details) run again on its open issue.
 * Only the newest run of the request's issue resumes, and only once it has stopped. */
export async function resumeRequest(context: IntakeContext, input: z.output<typeof resumeInput>) {
  requireEditor(context.identity);
  const [row] = (await context.db().all(sql`SELECT issue_url FROM foundry_requests WHERE id=${input.requestId} AND created_by=${context.identity.userId}`)) as { issue_url: string | null }[];
  const issue = row?.issue_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
  if (!issue) throw new Response("Request has no recorded issue", { status: 404 });
  const host = context.host();
  const repo = await submissionRepository(host, await host.call("snapshot", {}), issue[1]);
  const number = Number(issue[2]);
  const [latest] = await issueRuns(host, String(repo.repositoryId), number);
  if (!latest) throw new Response("The request's issue has no run to resume", { status: 409 });
  if (latest.status === "running") return { id: input.requestId, run: { id: latest.id, existing: true, status: latest.status } };
  const run = await startExistingFoundryIssue(host, repo.name, number, { runId: latest.id, requestId: input.resumeId });
  return { id: input.requestId, run: { id: run.id, existing: Boolean(run.existing), status: run.status } };
}
