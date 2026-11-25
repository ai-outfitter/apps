import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { IntakeContext } from "./intake";
import { foundryPlans } from "./schema";

const requestId = z.uuid();
export const planningIssueMarker = (runId: string) => `<!-- outfitter:foundry-plan:${runId} -->`;

type Repository = { id: number; name: string };
type Issue = { number: number; body?: string | null; authorId?: number };

/** Both the webhook and scheduled repair policy respect the durable planning
 * provenance. During a provider write the exact marker and bot identify the
 * issue. After confirmation, the persisted issue number survives body edits. */
export async function isPlanningIssue(db: IntakeContext["db"], repository: Repository, issue: Issue) {
  if (!issue.authorId) return false;
  const tag = [...(issue.body?.matchAll(/<!-- outfitter:foundry-plan:([a-f0-9-]+) -->/g) ?? [])].at(-1)?.[1];
  const repositoryName = repository.name.toLowerCase();
  const match = [
    eq(foundryPlans.anchorRepository, repositoryName),
    eq(foundryPlans.issuePublisherId, issue.authorId),
  ];
  const numberMatch = sql`json_extract(${foundryPlans.issue}, '$.number') = ${issue.number}`;
  const rows = await db().select().from(foundryPlans).where(and(...match,
    requestId.safeParse(tag).success ? or(eq(foundryPlans.runId, tag!), numberMatch) : numberMatch));
  return rows.some(row => row.repositoryGrants.some(grant => grant.name === repositoryName && grant.repositoryId === repository.id)
    && ["sending", "publication_uncertain", "published"].includes(row.state)
    && (row.issue ? row.issue.number === issue.number : row.runId === tag));
}

export async function generatedPlanningIssue(db: IntakeContext["db"], resource: string, event: unknown) {
  const payload = z.object({
    repository: z.object({ id: z.number().int(), full_name: z.string() }),
    issue: z.object({ number: z.number().int(), user: z.object({ id: z.number().int() }), body: z.string().nullable().optional() }),
  }).safeParse(event);
  if (!payload.success || String(payload.data.repository.id) !== resource) return false;
  const { issue, repository } = payload.data;
  return isPlanningIssue(db, { id: repository.id, name: repository.full_name },
    { number: issue.number, body: issue.body, authorId: issue.user.id });
}
