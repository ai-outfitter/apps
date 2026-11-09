import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { defineEntity, type EntityRef } from "@ai-outfitter/app-sdk/entities";
import type { PlanningDatabase } from "./planning";
import { workSubmissions, workEvaluations } from "./schema";

/** Canonical DB-only execution context. Provider observations are explicitly
 * dated facts; reads never contact a forge or claim current provider state. */
export function workEntities(db: PlanningDatabase) {
  const fields = z.strictObject({
    projectId: z.string(),
    packageDigest: z.string(),
    snapshot: z.json(),
    policy: z.json(),
    foundryReceipt: z.json(),
    observation: z.json(),
    review: z.json(),
    accepted: z.json(),
    evaluations: z.array(z.json()),
  });
  const parse = (text: string | null) => (text ? JSON.parse(text) : null);
  const hydrate = async (row: typeof workSubmissions.$inferSelect) => ({
    ...row,
    evaluations: (
      await db
        .select()
        .from(workEvaluations)
        .where(eq(workEvaluations.submissionId, row.id))
    ).map((evaluation) => parse(evaluation.data)),
  });
  return [
    defineEntity({
      type: "work-submission",
      title: "Planning work submission",
      description:
        "Immutable submitted context, separate criterion evaluations and recorded acceptance. Observed provider facts are dated; use work.get for current evidence and work.refresh to reconcile the Wiki projection.",
      schema: fields,
      name: (row: Awaited<ReturnType<typeof hydrate>>) =>
        `Work package: ${JSON.parse(row.snapshot).title}`.slice(0, 200),
      attributes: (row) => ({
        projectId: row.projectId,
        packageDigest: JSON.parse(row.snapshot).digest,
        snapshot: parse(row.snapshot),
        policy: parse(row.policy),
        foundryReceipt: parse(row.foundryReceipt),
        observation: parse(row.observation),
        review: parse(row.review),
        accepted: parse(row.accepted),
        evaluations: row.evaluations,
      }),
      references: (row, who) => [
        {
          installationId: who.installationId,
          type: "project",
          id: row.projectId,
        } satisfies EntityRef,
      ],
      list: async (who, offset, limit) =>
        Promise.all(
          (
            await db
              .select()
              .from(workSubmissions)
              .where(eq(workSubmissions.installationId, who.installationId))
              .orderBy(asc(workSubmissions.id))
              .offset(offset)
              .limit(limit)
          ).map(hydrate),
        ),
      get: async (who, id) => {
        const [row] = await db
          .select()
          .from(workSubmissions)
          .where(
            and(
              eq(workSubmissions.id, id),
              eq(workSubmissions.installationId, who.installationId),
            ),
          );
        if (!row)
          throw new Response("Work submission not found", { status: 404 });
        return hydrate(row);
      },
    }),
  ];
}
