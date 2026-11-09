import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { workflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { type BrandState, readState } from "./store";
import { batchState, recentBatches } from "./wiki";

/** The last Wiki change batch the interview was staged in. */
export type WikiBatch = { id: string; state: string; proposals: number; wikiPath: string; createdAt: number };

const empty: BrandState & { wikiBatch: WikiBatch | null } = { answers: [], sources: [], profile: null, nodes: [], drafts: [], wikiBatch: null };

/**
 * What a page renders. The demo build reads the synthetic fixture and never writes;
 * the operational app reads its installation database for the member. A request without
 * a forwarded member (the platform's deploy check) gets the empty shell.
 */
export async function pageState(request: Request, locals?: unknown): Promise<{ state: BrandState & { wikiBatch: WikiBatch | null }; canEdit: boolean; demo: boolean; signedOut?: boolean }> {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") {
    const fixture = (await import("../../fixtures/demo.json")).default as unknown as BrandState & { wikiBatch: WikiBatch | null };
    return { state: fixture, canEdit: false, demo: true };
  }
  let identity: ReturnType<typeof requestIdentity>;
  try {
    identity = requestIdentity(request);
  } catch (cause) {
    if (cause instanceof Response && cause.status === 401) return { state: empty, canEdit: false, demo: false, signedOut: true };
    throw cause;
  }
  const db = installationDatabase();
  const [state, [last]] = await Promise.all([readState(db), recentBatches(db)]);
  let wikiBatch: WikiBatch | null = last ? { id: last.id, state: last.state, proposals: last.proposals, wikiPath: last.wikiPath, createdAt: last.createdAt } : null;
  // A batch waiting for review may have been decided in the Wiki since: read its state (best effort).
  if (wikiBatch && last && locals && wikiBatch.state === "awaiting_review") {
    const current = await batchState(workflowHost<"interactive">(locals as never), last.wikiInstallationId, last.id, db).catch(() => null);
    if (current) wikiBatch = { ...wikiBatch, state: current };
  }
  return { state: { ...state, wikiBatch }, canEdit: identity.canEdit, demo: false };
}
