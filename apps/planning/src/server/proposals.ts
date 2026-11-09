import {
  ProposalStore as SharedProposalStore,
  type BatchDatabase,
} from "@ai-outfitter/app-sdk/proposal-store";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
export {
  canonicalJSON,
  digest,
  retainedStatuses,
} from "@ai-outfitter/app-sdk/proposal-store";
export type {
  Statement,
  BatchDatabase,
  ProposalRow,
  ProposalStatus,
} from "@ai-outfitter/app-sdk/proposal-store";
/** Existing Planning table identities and local atomic edit semantics remain unchanged. */
export class ProposalStore extends SharedProposalStore {
  constructor(
    db: BatchDatabase,
    identity: Pick<AppIdentity, "installationId" | "userId">,
  ) {
    super(db, identity, {
      table: "planning_proposals",
      guard: "planning_agent_guard",
    });
  }
}
