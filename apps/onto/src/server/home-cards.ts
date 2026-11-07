import {
  defineHomeCard,
  type HomeCardNode,
  type HomeCardSize,
} from "@ai-outfitter/app-sdk/home-cards";
import { typeSegment } from "@ai-outfitter/app-sdk/wiki";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { core } from "../lib/graph";
import { plainText } from "../lib/plain-text";
import type { Database } from "./graph";
import { graphBatches, graphNodes, graphTypes } from "./schema";
import { sealDueBatches } from "./graph-batches";

export const recentDocumentCounts: Record<HomeCardSize, number> = {
  small: 3,
  medium: 5,
  large: 10,
};

/** Latest active Documents; one indexed query bounded by the card size. */
export function recentDocuments(db: Database, limit: number) {
  return db
    .select({
      id: graphNodes.id,
      title: graphNodes.title,
      summary: graphNodes.summary,
      updatedAt: graphNodes.updatedAt,
    })
    .from(graphNodes)
    .where(
      and(eq(graphNodes.typeId, core.document), eq(graphNodes.archived, false)),
    )
    .orderBy(desc(graphNodes.updatedAt), asc(graphNodes.id))
    .limit(limit);
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The installation is the scope: an organization's or a person's own Wiki
 * database, read as the forwarded viewer. Links stay inside this Wiki. */
type CardBatch = { id: string; title: string; state: string; summary: string | null; reviewBy: number | null; policy: unknown; closedAt: number | null };

function batchSummary(batch: CardBatch) {
  try {
    const summary = batch.summary ? JSON.parse(batch.summary) : null;
    if (summary?.text) return String(summary.text);
    const parts = Object.entries((summary?.counts ?? {}) as Record<string, number>).map(([name, n]) => `${n} ${name}`);
    return parts.join(", ");
  } catch {
    return "";
  }
}

/** Batches waiting for review, and a first run's records created in the last day. */
export async function reviewQueue(db: Database, limit: number, now = Date.now()) {
  const rows: CardBatch[] = await db
    .select({ id: graphBatches.id, title: graphBatches.title, state: graphBatches.state, summary: graphBatches.summary, reviewBy: graphBatches.reviewBy, policy: graphBatches.policy, closedAt: graphBatches.closedAt })
    .from(graphBatches)
    .where(or(eq(graphBatches.state, "awaiting_review"), and(eq(graphBatches.state, "committed"), gt(graphBatches.closedAt, now - 24 * 3600 * 1000))))
    .orderBy(desc(graphBatches.updatedAt))
    .limit(limit * 3);
  return rows.filter((batch) => batch.state === "awaiting_review" || (batch.policy as { kind?: string })?.kind === "first-run").slice(0, limit);
}

/** The deadline in the review window's own time zone, which the reviewer chose. */
function clockTime(at: number, policy: unknown) {
  const zone = (policy as { reviewWindow?: { timezone?: string } } | null)?.reviewWindow?.timezone ?? "UTC";
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(at);
}

export function wikiCards(db: Database) {
  return [
    defineHomeCard({
      cardId: "changes-review",
      title: "Today's Wiki changes",
      description: "What agents found for your Wiki, waiting for your review or created on a first run.",
      sizes: ["small", "medium", "large"],
      defaultSize: "medium",
      async read({ identity, size }) {
        // Like the Changes pages, close review windows that have ended before listing.
        await sealDueBatches(db as Parameters<typeof sealDueBatches>[0], identity);
        const rows = await reviewQueue(db, recentDocumentCounts[size]);
        const body: HomeCardNode[] = rows.length
          ? [
              {
                kind: "list",
                label: "Review",
                items: rows.map(reviewItem),
              },
              { kind: "link", label: "All changes", target: { path: "/changes" } },
            ]
          : [{ kind: "empty", text: "Nothing waiting. Changes agents propose for your Wiki appear here." }];
        return { body, refreshedAt: new Date().toISOString() };
      },
    }),
    defineHomeCard({
      cardId: "recent-documents",
      title: "Recent documents",
      description: "The most recently updated documents in this Wiki.",
      sizes: ["small", "medium", "large"],
      defaultSize: "medium",
      async read({ size }) {
        const [type] = await db
          .select({ name: graphTypes.name, archived: graphTypes.archived })
          .from(graphTypes)
          .where(eq(graphTypes.id, core.document));
        if (!type || type.archived)
          return {
            unavailable: "setup-required",
            message: "This Wiki has no active Document type.",
          };
        const collection = `/${typeSegment(type.name)}`;
        const rows = await recentDocuments(db, recentDocumentCounts[size]);
        const body: HomeCardNode[] = rows.length
          ? [
              {
                kind: "list",
                label: "Recently updated",
                items: rows.map((row) => {
                  const summary = plainText(row.summary, 280);
                  return {
                    id: row.id,
                    title: plainText(row.title, 120) || "Untitled document",
                    ...(summary ? { subtitle: summary } : {}),
                    meta: `Updated ${day(row.updatedAt)}`,
                    link: {
                      path: `${collection}/${encodeURIComponent(row.id)}`,
                    },
                  };
                }),
              },
              {
                kind: "link",
                label: "All documents",
                target: { path: collection },
              },
            ]
          : [
              {
                kind: "empty",
                text: "No documents yet. Documents you add to the Wiki appear here.",
                link: {
                  kind: "link",
                  label: "Open documents",
                  target: { path: collection },
                },
              },
            ];
        return { body, refreshedAt: new Date().toISOString() };
      },
    }),
  ];
}

/** One batch on the Today card: a first run already created its records; others wait. */
function reviewItem(batch: Awaited<ReturnType<typeof reviewQueue>>[number]) {
  const summary = plainText(batchSummary(batch), 280);
  const first = batch.state === "committed";
  const waiting = batch.reviewBy ? `Approves automatically at ${clockTime(batch.reviewBy, batch.policy)} unless you review it` : "Waiting for your approval";
  return {
    id: batch.id,
    title: plainText(first ? `Created from your sources: ${batch.title}` : batch.title, 120) || "Proposed changes",
    ...(summary ? { subtitle: summary } : {}),
    meta: first ? "Created on the first run · open to see what was added" : waiting,
    status: first ? { label: "Created", tone: "info" as const } : { label: "Review", tone: "warning" as const },
    link: { path: `/changes/${encodeURIComponent(batch.id)}` },
  };
}
