import { type AppActor, type AppIdentity, requireEntityWriter } from "@ai-outfitter/app-sdk/server";
import { batchRemoveInput } from "@ai-outfitter/app-sdk/graph-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { graphBatches } from "./schema";
import { type Database, getBatch, live, loadBatch, loadOperations, requireMemberReview, requireOpen } from "./graph-batches";

// Questions on a batch (docs/plans/agent-questions.md). An agent asks a member about the
// proposals it staged; the member answers on the Changes page. A question is work, not a
// fact: it never reaches the graph, it approves and blocks nothing, and it closes with its
// batch. The agent fixes its proposals with ReviseBatch, citing the answer as evidence
// ({provider: "onto", recordId: "batch:<id>#<key>"}), so the answer outlives the batch.

export type BatchAnswer = { option?: string; text?: string; by: string; at: number };
export type BatchQuestion = { key: string; ask: string; refs: string[]; options?: string[]; answer?: BatchAnswer };

export const questionCap = 20;
const questionKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Use lowercase letters, digits and '-', at most 64")
  .describe("Names the question in this batch, such as board-role. Asking again with the same key replaces it.");
const question = z.strictObject({
  key: questionKey,
  ask: z.string().trim().min(1).max(500).describe("One plain question for a member."),
  refs: z.array(batchRemoveInput.shape.refs.element).max(100).default([]).describe("Refs of the proposals in this batch that depend on the answer."),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6).optional().describe("Answers the member can pick; they can still type their own."),
});
export const batchAskInput = z.strictObject({
  batchId: z.uuid(),
  questions: z.array(question).max(questionCap).default([]),
  remove: z.array(questionKey).max(questionCap).default([]).describe("Keys of questions to take back."),
}).refine(input => input.questions.length + input.remove.length > 0, "Ask a question or name one to remove");
export const batchAnswerInput = z.strictObject({
  batchId: z.uuid(),
  key: questionKey,
  option: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(500).optional(),
}).refine(input => !!input.option !== !!input.text, "Pick an option or type an answer");

function fail(message: string, status = 400): never {
  throw new Response(message, { status });
}
const answerable = (state: string) => state === "open" || state === "awaiting_review";

/** Writes the questions only if nobody changed them, or closed the batch, since they were read. */
async function saveQuestions(db: Database, batch: { id: string; state: string; questions: BatchQuestion[] | null }, questions: BatchQuestion[]) {
  const saved = await db.update(graphBatches).set({ questions: questions.length ? questions : null, updatedAt: Date.now() })
    .where(and(eq(graphBatches.id, batch.id), inArray(graphBatches.state, ["open", "awaiting_review"]),
      sql`${graphBatches.questions} IS ${batch.questions ? JSON.stringify(batch.questions) : null}`))
    .returning({ id: graphBatches.id });
  if (!saved.length) fail("Batch changed; reload before changing its questions", 409);
}

/** Add, replace or take back questions on an open batch, or one awaiting member review. */
export async function askBatch(db: Database, who: AppIdentity, actor: AppActor, input: z.infer<typeof batchAskInput>) {
  requireEntityWriter(who);
  const batch = await loadBatch(db, input.batchId);
  if (batch.state === "open") requireOpen(batch, actor);
  else if (batch.state !== "awaiting_review" || batch.policy.kind !== "member")
    fail("Questions can only be asked on an open batch or one awaiting member review", 409);
  if (new Set(input.questions.map(item => item.key)).size !== input.questions.length) fail("Each question needs a distinct key");
  const refs = new Set(live(await loadOperations(db, batch.id)).map(row => row.ref));
  for (const item of input.questions) for (const ref of item.refs)
    if (!refs.has(ref)) fail(`${ref} is not a proposal in this batch`);
  const prior = new Map((batch.questions ?? []).map(item => [item.key, item]));
  for (const key of input.remove) prior.delete(key);
  for (const item of input.questions) {
    const was = prior.get(item.key);
    // A reworded question, or new choices, needs a new answer.
    const same = was && was.ask === item.ask && JSON.stringify(was.options ?? null) === JSON.stringify(item.options ?? null);
    prior.set(item.key, { ...item, ...(same && was.answer ? { answer: was.answer } : {}) });
  }
  const questions = [...prior.values()];
  if (questions.length > questionCap) fail(`A batch holds at most ${questionCap} questions`, 413);
  await saveQuestions(db, batch, questions);
  return getBatch(db, who, { batchId: batch.id });
}

/** A member answers with one of the options or a line of text. It approves nothing. */
export async function answerBatch(db: Database, who: AppIdentity, actor: AppActor, origin: AppActor, input: z.infer<typeof batchAnswerInput>) {
  requireMemberReview(who, actor, origin);
  const batch = await loadBatch(db, input.batchId);
  if (!answerable(batch.state)) fail("The batch is closed; its questions closed with it", 409);
  const questions = batch.questions ?? [];
  const asked = questions.find(item => item.key === input.key);
  if (!asked) fail("No such question in this batch", 404);
  if (input.option && !asked.options?.includes(input.option)) fail("Pick one of the question's options or type an answer");
  const answer: BatchAnswer = { ...(input.option ? { option: input.option } : { text: input.text }), by: who.userId, at: Date.now() };
  await saveQuestions(db, batch, questions.map(item => item.key === input.key ? { ...item, answer } : item));
  return getBatch(db, who, { batchId: batch.id });
}

/** Questions waiting for an answer: none once the batch has closed. */
export const openQuestions = (batch: { state: string; questions: BatchQuestion[] | null }) =>
  answerable(batch.state) ? (batch.questions ?? []).filter(item => !item.answer).length : 0;

const citation = /^batch:([0-9a-f-]{36})#([a-z0-9][a-z0-9-]{0,63})$/i;
/** An evidence item citing a batch answer must name a question that has one. */
export async function requireAnsweredCitations(db: Database, evidence: { provider: string; recordId: string }[]) {
  const cited = evidence.filter(item => item.provider === "onto" && item.recordId.startsWith("batch:"));
  for (const item of cited) {
    const [, batchId, key] = citation.exec(item.recordId) ?? [];
    const [batch] = batchId ? await db.select({ questions: graphBatches.questions }).from(graphBatches).where(eq(graphBatches.id, batchId.toLowerCase())) : [];
    if (!batch?.questions?.some(question => question.key === key && question.answer))
      fail(`Evidence ${item.recordId} names no answered question; cite batch:<id>#<key> after a member answers`);
  }
}
