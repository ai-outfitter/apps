import { z } from "zod";
import { Workflow } from "./schema";

/** Portable workflow data. The containing app package's content hash pins this
 * definition; runtime authorization never trusts a caller-supplied digest. */
export const WorkflowPackage = z.object({
  package: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
  version: z.string().min(1).max(64),
  definition: Workflow,
}).strict();
export type WorkflowPackage = z.infer<typeof WorkflowPackage>;

export const WorkflowPackages = z.array(WorkflowPackage).max(64).refine(
  (items) => new Set(items.map((item) => item.definition.id)).size === items.length, "Duplicate workflow id");

export const workflowDefinitionIdentity = (definition: Workflow) => JSON.stringify(definition, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
