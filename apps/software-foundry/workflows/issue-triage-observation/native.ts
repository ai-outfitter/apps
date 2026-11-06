import { z } from "zod";

type Record_ = { connector:string; record:string; value:unknown };

export const triageObservationWorkflowId = "issue-triage-observation";
export const triageWorkflowPath = ".github/workflows/outfitter-managed-node.yml";
export const observedRecordTypes = ["github.issue-comment"];
export const sourceReceiptSlot = "github-webhook.outputs.started";
export const eventInputSlot = "github-webhook.inputs.event";
export const currentRunReadOperation = "actions-run.read";
export const observationRecord = {connector:"database",record:"observation.issue-triage"};
export const inferenceWorkloadKind = "actions";
export const inferenceWorkloadId = (repository:string,runId:number) => `${repository}#${runId}`;
const marker = /^<!-- outfitter:triage:([1-9][0-9]*) -->/;
const id = z.number().int().positive();
const common = { repositoryId: id, repository: z.string(), installationId: id };
const comment = z.object({ ...common, kind: z.literal("issue-comment"), action: z.literal("created"),
  issueNumber: id, commentId: id, body: z.string(), url: z.string().url(),
  author: z.object({ login: z.literal("github-actions[bot]"), type: z.literal("Bot") }),
});
const run = z.object({ ...common, kind: z.literal("workflow-run"), action: z.enum(["requested","in_progress","completed"]),
  runId: id, attempt: id, name: z.string().min(1),
  displayTitle: z.string(), path: z.literal(triageWorkflowPath), event: z.literal("issues"),
  status: z.string(), conclusion: z.string().nullable(), url: z.string().url(),
});
export type TriageModelEvidence = { requestKey: string; usageRecordId: string; model: string };
export type TriageContext = { repositoryId:number; repository:string; installationId:number; issueNumber:number };
const issueEvent = z.object({installation:z.object({id}), repository:z.object({id,full_name:z.string()}),
  issue:z.object({number:id})});
export function triageContext(inputs:Record<string,unknown>):TriageContext | undefined {
  const event=issueEvent.safeParse(inputs[eventInputSlot]);
  if(!event.success) return;
  return {repositoryId:event.data.repository.id,repository:event.data.repository.full_name,
    installationId:event.data.installation.id,issueNumber:event.data.issue.number};
}
export function triageRunIds(context:TriageContext,records:Record_[]) {
  return [...new Set(records.filter(row=>row.record==="github.issue-comment").flatMap(row=>{
    const parsed=comment.safeParse(row.value);
    if(!parsed.success) return [];
    const value=parsed.data;
    if(value.repositoryId!==context.repositoryId || value.repository!==context.repository ||
        value.installationId!==context.installationId || value.issueNumber!==context.issueNumber) return [];
    const runId=Number(marker.exec(value.body)?.[1]);
    return Number.isSafeInteger(runId) && runId>0 ? [runId] : [];
  }))];
}
export function triageModelEvidence(conversation:{requestKey:string;workloadId:string;status:string;model:string|null;
  requestMessages:string;responseMessage:string},usage:{id:string;requestKey:string;workloadId:string;model:string;
  inputTokens:number|null;outputTokens:number|null;totalTokens:number|null} | undefined):TriageModelEvidence | undefined {
  if(conversation.status!=="200" || !conversation.model || !/^(openai\/)?gpt-6-(luna|sol|astra)$/.test(conversation.model) ||
      !usage || usage.requestKey!==conversation.requestKey || usage.workloadId!==conversation.workloadId ||
      usage.model!==conversation.model || !usage.inputTokens || !usage.outputTokens || !usage.totalTokens) return;
  try {
    const request=JSON.parse(conversation.requestMessages) as {messages?:unknown[]};
    const response=JSON.parse(conversation.responseMessage) as {message?:{content?:unknown;tool_calls?:unknown[]}};
    if(!request.messages?.length || !response.message ||
        !(typeof response.message.content==="string" && response.message.content.trim()) &&
        !response.message.tool_calls?.length) return;
    return {requestKey:conversation.requestKey,usageRecordId:usage.id,model:conversation.model};
  } catch { return; }
}

/** A comment's marker identifies the Actions run. A successful completed run
 * alone is never triage evidence; the bot comment and metered model call must
 * both exist for the same repository, issue and run. */
export function triageEvidence(input: TriageContext, records: Record_[], model: (runId: number) => TriageModelEvidence | undefined) {
  const comments = records.filter(row => row.record === "github.issue-comment")
    .map(row => comment.safeParse(row.value)).filter(row => row.success).map(row => row.data)
    .filter(row => row.repositoryId === input.repositoryId && row.repository === input.repository &&
      row.installationId === input.installationId && row.issueNumber === input.issueNumber);
  const runs = records.filter(row => row.record === "github.workflow-run")
    .map(row => run.safeParse(row.value)).filter(row => row.success).map(row => row.data)
    .filter(row => row.repositoryId === input.repositoryId && row.repository === input.repository &&
      row.installationId === input.installationId &&
      [`Triage issue #${input.issueNumber}`, `Issue #${input.issueNumber}: triage`].includes(row.displayTitle));
  const candidates = [];
  for (const posted of comments) {
    const runId = Number(marker.exec(posted.body)?.[1]);
    if (!Number.isSafeInteger(runId)) continue;
    const attempts = runs.filter(row => row.runId === runId);
    const latestAttempt = Math.max(...attempts.map(row => row.attempt));
    const terminal = attempts.filter(row => row.attempt === latestAttempt && row.action === "completed");
    const latest = terminal.length && terminal.every(row => row.status === "completed" && row.conclusion === "success") ? terminal[0] : undefined;
    if (!latest ||
        comments.filter(row => row.body.startsWith(`<!-- outfitter:triage:${runId} -->`)).length !== 1) continue;
    const inference = model(runId);
    if (!inference) continue;
    const readiness = /Ready for work:\s*(yes|no)\b/i.exec(posted.body);
    const plan = /Plan:\s*([\s\S]+)/i.exec(posted.body)?.[1]?.trim();
    if (!readiness || !plan) continue;
    candidates.push({ ready: readiness[1].toLowerCase() === "yes", plan, repositoryId: input.repositoryId, issueNumber: input.issueNumber,
      actionsRunId: runId, attempt: latest.attempt, actionsUrl: latest.url,
      commentId: posted.commentId, commentUrl: posted.url, commentBody:posted.body,
      conversationRequestKey: inference.requestKey, usageRecordId: inference.usageRecordId, model: inference.model });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}


/** Reconcile provider facts after the resident approves the implemented head. */
export function triageLifecycleInput(inputs: Record<string, unknown>, rows: Record<string, {value:unknown;complete:boolean}>) {
  const row = rows["implement.outputs.pull-request"];
  const reviewRow = rows["review.outputs.review"];
  if (!row?.complete || !reviewRow?.complete) return null;
  const event = z.object({issue:z.object({number:id})}).safeParse(inputs[eventInputSlot]);
  const settings = z.object({reviewerLogin:z.string().min(1)}).safeParse(inputs["github-webhook.inputs.settings"]);
  const pr = z.object({number:id,headSha:z.string().regex(/^[a-f0-9]{40}$/)}).safeParse(row.value);
  const review = z.object({decision:z.literal("approved"),headSha:z.string().regex(/^[a-f0-9]{40}$/)}).safeParse(reviewRow.value);
  if (!event.success || !settings.success || !pr.success || !review.success || review.data.headSha !== pr.data.headSha) return null;
  return {operation:"lifecycle.read", input:{issueNumber:event.data.issue.number,
    pullRequestNumber:pr.data.number,headSha:pr.data.headSha,reviewerLogin:settings.data.reviewerLogin,
    verificationWorkflowPath:".github/workflows/verify-production.yml",verificationJobName:"verify"}};
}
