import { forgejoMutationNotDispatched } from "@ai-outfitter/app-sdk/workflow-host";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { IntakeContext } from "../intake";
import { forgejoIssueReviews as runs } from "../schema";

export type ChangeFile = { path: string; operation: "create" | "update"; content: string; sha?: string };
type Payload = {
  branch: { branch: string; base: string; files: ChangeFile[]; summary: string };
  commit: { branch: string; message: string; files: ChangeFile[] };
  draft: { head: string; base: string; title: string; body: string };
  review: {
    operation: "publish-review";
    reviewer: string;
    expectedReviewerId: number;
    candidate: { number: number; headSha: string };
    verdict: "approved" | "changes-requested";
    summary: string;
  };
};
type Kind = keyof Payload;
export type ReviewEffect<K extends Kind = Kind> = {
  [P in K]: { kind: P; token: string; retryable: boolean; payload: Payload[P] }
}[K];
type Db = IntakeContext["db"];

export function newEffect<K extends Kind>(kind: K, payload: Payload[K]): ReviewEffect<K> {
  return { kind, token: crypto.randomUUID(), retryable: false, payload } as ReviewEffect<K>;
}

export function readyEffect<K extends Kind>(effect: ReviewEffect | null, kind: K) {
  return effect?.kind === kind && effect.retryable ? effect as ReviewEffect<K> : null;
}

function pending(kind: Kind) {
  switch (kind) {
    case "branch": return isNull(runs.commitClaim);
    case "commit": return and(isNull(runs.publication), sql`json_extract(${runs.commitProof}, '$.headSha') is null`);
    case "draft": return and(isNull(runs.candidate),
      sql`coalesce(json_extract(${runs.draftObservation}, '$.status'), '') <> 'blocked'`);
    case "review": return isNull(runs.review);
  }
}

function exactEffect(runId: string, effect: ReviewEffect) {
  return and(eq(runs.runId, runId), eq(runs.effectDispatch, effect), pending(effect.kind));
}

/** Consumes the affirmative refusal once, fencing each dispatch with a fresh token. */
type RetryFields = { reviewPublication?: typeof runs.$inferInsert.reviewPublication };

export function retryEffect<K extends Kind>(db: Db, runId: string, ready: ReviewEffect<K>,
  fields?: RetryFields): Promise<ReviewEffect<K> | null>;
export async function retryEffect(db: Db, runId: string, ready: ReviewEffect, fields: RetryFields = {}) {
  if (!ready.retryable) return null;
  const next = { ...ready, token: crypto.randomUUID(), retryable: false };
  const [claimed] = await db().update(runs).set({ ...fields, effectDispatch: next })
    .where(exactEffect(runId, ready)).returning({ runId: runs.runId });
  return claimed ? next : null;
}

async function hostProvedNoSend(error: unknown) {
  return error instanceof Response && error.status === forgejoMutationNotDispatched.status &&
    await error.clone().text().catch(() => null) === forgejoMutationNotDispatched.message;
}

export async function dispatchEffect<T>(db: Db, runId: string, effect: ReviewEffect, send: () => Promise<T>) {
  try {
    return await send();
  } catch (error) {
    if (await hostProvedNoSend(error)) {
      await db().update(runs).set({ effectDispatch: { ...effect, retryable: true } })
        .where(exactEffect(runId, effect));
      throw new Response("The provider write was not sent; retrying its frozen claim", { status: 503 });
    }
    // Unknown delivery leaves the claim closed for read-only reconciliation.
    return undefined;
  }
}
