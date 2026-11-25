import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { sql } from "drizzle-orm";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { verifiedSources, type ReadHost } from "./passage-source";
import { plan, resolvePassage } from "./passage-grounding";
import type { Graph } from "../lib/graph";
import { graphBatches } from "./schema";

export const passageBatchPrefix = "wiki-passage-index:";
type Batch = { id: string; source: Record<string, unknown> | null };
export const isPassageBatch = (batch: Batch) => typeof batch.source?.ref === "string" && batch.source.ref.startsWith(passageBatchPrefix);

const requests = new AsyncLocalStorage<{
  identity: () => AppIdentity;
  host: () => ReadHost;
  access: Map<string, Promise<Set<string>>>;
}>();

export function withPassageReviewHost<T>(identity: () => AppIdentity, host: () => ReadHost, work: () => T) {
  return requests.run({ identity, host, access: new Map() }, work);
}

type Database = ReturnType<typeof installationDatabase>;
type Binding = { organizationId: string; wikiInstallationId: string; sourceId: string; version: string };

export async function requirePassageBatchAccess(db: Database, batch: Batch, current = false) {
  if (!isPassageBatch(batch)) return;
  const request = requests.getStore();
  if (!request) throw new Response("Wiki access is required for this batch", { status: 403 });
  const who = request.identity();
  const binding = await db.get<Binding>(sql`SELECT organizationId,wikiInstallationId,sourceId,version
    FROM onto_passage_suggestions WHERE id=${String(batch.source!.ref).slice(passageBatchPrefix.length)} AND batchId=${batch.id}`);
  if (!binding || binding.organizationId !== who.organizationId || who.callerOrganizationId)
    throw new Response("Wiki passage batch unavailable", { status: 404 });
  if (current) {
    const active = await verifiedSources(request.host(), who, binding.wikiInstallationId, [binding]);
    if (!active.has(binding.sourceId)) throw new Response("The Wiki source changed; review its latest passage suggestions", { status: 409 });
    return;
  }
  await checkAccess(request, who, binding.wikiInstallationId);
}

/** Load the pinned quote before committing. Revalidate against the graph
 * snapshot fenced by graph.apply, so new ambiguity or duplicates fail closed. */
export async function passageApproval(db: Database, batch: Batch, operations: { operation: unknown }[]) {
  if (!isPassageBatch(batch)) return;
  await requirePassageBatchAccess(db, batch, true);
  const row = await db.get<{ plan: string; text: string }>(sql`SELECT s.plan,p.text
    FROM onto_passage_suggestions s JOIN onto_passages p ON p.id=s.passageId
    WHERE s.batchId=${batch.id} AND s.id=${String(batch.source!.ref).slice(passageBatchPrefix.length)}`);
  const parsed = row && plan.safeParse(JSON.parse(row.plan));
  if (!parsed?.success || parsed.data.evidence?.quote !== parsed.data.quote || !row?.text.includes(parsed.data.quote))
    throw new Response("The Wiki passage evidence changed; review its latest suggestions", { status: 409 });
  const expected = canonicalActionValue(operations.map(row => row.operation));
  return (graph: Graph) => {
    const resolved = resolvePassage(graph, parsed.data);
    if ("issue" in resolved) throw new Response(resolved.issue, { status: 409 });
    if (canonicalActionValue(resolved.operations) !== expected)
      throw new Response("The Wiki passage anchors changed; review its latest suggestions", { status: 409 });
  };
}

function checkAccess(request: NonNullable<ReturnType<typeof requests.getStore>>, who: AppIdentity, wiki: string) {
  // One access check per Wiki per request, irrespective of the number of batches listed.
  let access = request.access.get(wiki);
  if (!access) {
    access = verifiedSources(request.host(), who, wiki, []);
    request.access.set(wiki, access);
  }
  return access;
}

/** Apply the same visibility to counts and cursor pages as to detail reads. */
export async function passageBatchVisibility(db: Pick<Database, "all">) {
  const ref = sql`coalesce(json_extract(${graphBatches.source}, '$.ref'),'')`;
  const ordinary = sql`substr(${ref},1,${passageBatchPrefix.length}) <> ${passageBatchPrefix}`;
  const request = requests.getStore();
  if (!request) return ordinary;
  const who = request.identity();
  if (!who.organizationId || who.callerOrganizationId) return ordinary;
  const indexes = await db.all<{ wikiInstallationId: string }>(sql`SELECT wikiInstallationId FROM onto_passage_indexes
    WHERE organizationId=${who.organizationId}`);
  const permissions = await Promise.all(indexes.map(async ({ wikiInstallationId: wiki }) => {
    try {
      await checkAccess(request, who, wiki);
      return wiki;
    } catch {
      return null;
    }
  }));
  const allowed = permissions.filter(wiki => wiki !== null);
  if (!allowed.length) return ordinary;
  return sql`(${ordinary} OR EXISTS(SELECT 1 FROM onto_passage_suggestions p
    WHERE p.batchId=${graphBatches.id} AND p.organizationId=${who.organizationId}
      AND p.wikiInstallationId IN (SELECT value FROM json_each(${JSON.stringify(allowed)}))
      AND p.id=substr(${ref},${passageBatchPrefix.length + 1})))`;
}
