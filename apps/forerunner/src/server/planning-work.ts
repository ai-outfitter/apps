import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { currentMemberships } from "./day-review";

/** Issues marked in progress in Planning, in each organization the member belongs to that has Planning. */
export type PlanningWork = {
  status: "complete" | "incomplete" | "unavailable";
  issues: { title: string; category: string; dueDate: string | null; scope: string; organization: string; href: string }[];
};
const answer = z.object({
  data: z.object({ issues: z.array(z.object({
    projectId: z.string(), title: z.string(), category: z.string(), status: z.string(), dueDate: z.string().nullish(),
    scope: z.string(), organization: z.object({ slug: z.string(), name: z.string().nullish() }).nullish(),
  })) }),
  next: z.unknown().optional(),
});
/** At most this many issues are read; the brief says when more were left out. */
export const planningWorkLimit = 30;

/**
 * One federated read of Planning's published `Issues` document, limited to the
 * member's organizations. A failed read is a stated gap, never "nothing in progress".
 */
export async function readPlanningWork(host: WorkflowHost<"interactive">): Promise<PlanningWork> {
  try {
    const orgs = (await currentMemberships(host)).filter(org => org.appSlugs.includes("planning"));
    if (!orgs.length) return { status: "complete", issues: [] };
    const result = answer.parse(await host.call("platform.document", {
      app: "planning", document: "Issues", kind: "query", scopes: orgs.map(org => org.slug), variables: { status: ["in-progress"], limit: planningWorkLimit },
    }));
    const issues = result.data.issues.filter(issue => issue.status === "in-progress").map(issue => ({
      title: issue.title, category: issue.category, dueDate: issue.dueDate ?? null, scope: issue.scope,
      organization: issue.organization?.name ?? issue.scope, href: `/o/${encodeURIComponent(issue.scope)}/planning/projects/${encodeURIComponent(issue.projectId)}`,
    }));
    return { status: result.next ? "incomplete" : "complete", issues };
  } catch { return { status: "unavailable", issues: [] }; }
}
