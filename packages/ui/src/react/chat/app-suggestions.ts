import type { WorkProfile } from "@ai-outfitter/app-sdk/platform-records";
import { APP_OPERATIONS, type AppOperation } from "@ai-outfitter/workflow-email-profile-onboarding/types";

// How a work profile's suggested app reads: who it is for and what its
// connector operations do. Shared by the suggestion cards and the first
// version of an app the platform builds from one.

export type SuggestedApp = WorkProfile["suggestedApps"][number];

/** A suggested app and its place on the profile, which Build this names it by. */
export type AppToBuild = { index: number; app: SuggestedApp };

export const AUDIENCE: Record<SuggestedApp["audience"], string> = { self: "You", customers: "Your customers", team: "Your team" };

/** "read Gmail, create Gmail drafts": what an app's operations do, each said once. */
export const operationsText = (operations: readonly string[]) =>
  [...new Set(operations.map((operation) => APP_OPERATIONS[operation as AppOperation] ?? operation))].join(", ");
