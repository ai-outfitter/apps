// Explorations: saved views of the graph that people and agents share
// (docs/graph-explorer.md). The explore page and agents change one with the same
// merge patch (MutateExploration); every read rebuilds its picture from current
// records (lib/exploration-picture.ts).

import { type GithubPullRequest, githubPullRequests, type PullRequestHost } from "@ai-outfitter/app-sdk/github-pulls";
import type { AppActor, AppIdentity } from "@ai-outfitter/app-sdk/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
  changeExploration, explorationState, mutateExplorationInput, type PictureProviders, pullRequestLimit, resolvePicture, type StagedOperation,
} from "../lib/exploration-picture";
import type { Database } from "./graph";
import { databaseSource } from "./graph-source";
import { graphBatches, graphBatchOperations, graphExplorations } from "./schema";

export * from "../lib/exploration-picture";

type Row = typeof graphExplorations.$inferSelect;
const view = async (db: Database, row: Row, providers: PictureProviders) => {
  const state = explorationState.parse(row.state);
  return { slug: row.slug, title: row.title, revision: row.revision, state, lastChange: row.lastChange ?? null, picture: await resolvePicture(databaseSource(db), state, providers) };
};

/** Staged creates in batches a member has not decided yet (at most 500 operations). */
export const stagedProposals = (db: Database) => (): Promise<StagedOperation[]> =>
  db.select({ batchId: graphBatchOperations.batchId, ref: graphBatchOperations.ref, operation: graphBatchOperations.operation })
    .from(graphBatchOperations).innerJoin(graphBatches, eq(graphBatches.id, graphBatchOperations.batchId))
    .where(and(inArray(graphBatches.state, ["open", "awaiting_review"]), inArray(graphBatchOperations.state, ["pending", "awaiting_review"])))
    .limit(500);

/** Live reads through the app's workflow host, each repository read once per request, and staged proposals. */
export function pictureProviders(db: Database, host: (() => PullRequestHost) | undefined): PictureProviders {
  return { ...hostProviders(host), proposals: stagedProposals(db) };
}

function hostProviders(host: (() => PullRequestHost) | undefined): PictureProviders {
  if (!host) return {};
  const reads = new Map<string, Promise<GithubPullRequest[]>>();
  return {
    pullRequests: (repository) => {
      if (!reads.has(repository)) reads.set(repository, (async () => {
        try { return (await githubPullRequests(host(), repository, pullRequestLimit)).nodes; }
        // A refused host call (no host, not an editor) is this step's problem, not the whole read's.
        catch (error) { throw error instanceof Response ? new Error(`Pull requests are read live from GitHub, which this request cannot reach (${error.status})`) : error; }
      })());
      return reads.get(repository) as Promise<GithubPullRequest[]>;
    },
  };
}

export async function listExplorations(db: Database) {
  const rows = await db.select().from(graphExplorations).orderBy(asc(graphExplorations.title));
  return rows.map(row => ({ slug: row.slug, title: row.title, revision: row.revision, start: explorationState.parse(row.state).start }));
}

export async function readExploration(db: Database, slugValue: string, providers: PictureProviders = {}) {
  const [row] = await db.select().from(graphExplorations).where(eq(graphExplorations.slug, slugValue));
  return row ? view(db, row, providers) : null;
}

/** Apply a merge patch to an exploration (or create it at revision 0). Any Wiki
 * member may change a view: it writes no records and reads only what they can read. */
export async function mutateExploration(db: Database, identity: AppIdentity, actor: AppActor | undefined, raw: z.input<typeof mutateExplorationInput>, providers: PictureProviders = {}) {
  const input = mutateExplorationInput.parse(raw);
  const [row] = await db.select().from(graphExplorations).where(eq(graphExplorations.slug, input.slug));
  const current = row?.revision ?? 0;
  if (input.expectedRevision !== current)
    throw new Response(`The exploration is at revision ${current}, not ${input.expectedRevision}. Read it again and rebuild the patch.`, { status: 409 });
  const before = row ? explorationState.parse(row.state) : undefined;
  const { state, picture, lastChange } = await changeExploration(databaseSource(db), before, input, { by: actor?.label ?? identity.userId, via: actor?.kind ?? "member" }, providers);
  const revision = current + 1;
  if (!input.dryRun) {
    const now = Date.now();
    const values = { title: state.title, state, revision, lastChange, updatedAt: now };
    const written = row
      ? await db.update(graphExplorations).set(values).where(and(eq(graphExplorations.slug, input.slug), eq(graphExplorations.revision, current))).returning({ revision: graphExplorations.revision })
      : await db.insert(graphExplorations).values({ slug: input.slug, ...values, createdBy: identity.userId, createdAt: now }).onConflictDoNothing().returning({ revision: graphExplorations.revision });
    if (!written.length) throw new Response("Someone else changed this exploration; read it again", { status: 409 });
  }
  return { slug: input.slug, title: state.title, revision: input.dryRun ? current : revision, state, lastChange, picture, dryRun: input.dryRun };
}
