import { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requestIdentity } from "@ai-outfitter/app-sdk/server";
import { type BrandState, readState } from "./store";

const empty: BrandState = { answers: [], sources: [], profile: null, nodes: [], drafts: [] };

/**
 * What a page renders. The demo build reads the synthetic fixture and never writes;
 * the operational app reads its installation database for the member. A request without
 * a forwarded member (the platform's deploy check) gets the empty shell.
 */
export async function pageState(request: Request): Promise<{ state: BrandState; canEdit: boolean; demo: boolean; signedOut?: boolean }> {
  if (import.meta.env.OUTFITTER_APP_MODE !== "operational") {
    const fixture = (await import("../../fixtures/demo.json")).default as unknown as BrandState;
    return { state: fixture, canEdit: false, demo: true };
  }
  let identity: ReturnType<typeof requestIdentity>;
  try {
    identity = requestIdentity(request);
  } catch (cause) {
    if (cause instanceof Response && cause.status === 401) return { state: empty, canEdit: false, demo: false, signedOut: true };
    throw cause;
  }
  return { state: await readState(installationDatabase()), canEdit: identity.canEdit, demo: false };
}
