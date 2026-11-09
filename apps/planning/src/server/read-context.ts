import type { ActionContext } from "@ai-outfitter/app-sdk/actions";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { PlanningDatabase } from "./planning";

/** Shared request-scoped dependencies for read-only Planning exploration. */
export type PlanningReadContext = ActionContext & {
  db: () => PlanningDatabase;
  host: () => WorkflowHost<"interactive">;
};
