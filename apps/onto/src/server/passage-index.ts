import { defineAction, type ActionContext as SDKActionContext } from "@ai-outfitter/app-sdk/actions";
import type { AgentStatement } from "@ai-outfitter/app-sdk/agent-store";
import { agentDatabase, installationDatabase } from "@ai-outfitter/app-sdk/cloudflare/database";
import { requireEditor, sha256Hex, type AppIdentity } from "@ai-outfitter/app-sdk/server";
import { scheduleInput, type PhaseInput, type WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { checkWikiOwner, locator, orgId, scopeInput, sourceInventory, sourceRead, verifiedSources, wikiSource,
  retryAt, statement, type IndexScope, type ReadHost, type Worker } from "./passage-source";
import { closePassageBatches } from "./graph-batches";
import { inferPassages, routePassageSuggestions } from "./passage-routing";

export const passageWorkflow = "wiki-passage-index";
const cron = "0 */6 * * *";
const progressSlot = "index.outputs.progress";
const leaseMs = 15 * 60_000;
const selectSize = 100;
const sourceBudget = 60;
const actionResponseBytes = 4 * 1024 * 1024;

const indexKey = "organizationId=? AND wikiInstallationId=?";
const scope = (who: AppIdentity, wiki: string): IndexScope => ({
  who, wiki, db: agentDatabase(), keys: [orgId(who), wiki],
});

const count = z.number().int().nonnegative();
const progressResult = z.object({
  cursor: z.string().nullable(), sweeps: count, updatedAt: count.nullable(), lastError: z.string().nullable(),
  indexedSources: count, pendingSources: count, sourceIssues: count, indexedPassages: count,
  pendingPassages: count, inferenceRetries: count, routed: count, pendingSuggestions: count,
  unresolved: count, routingRetries: count,
});

async function progress({ db, keys }: IndexScope) {
  const [[index], [sources], [passages], [suggestions]] = await Promise.all([
    db.query(statement(`SELECT cursor,sweeps,updatedAt,lastError FROM onto_passage_indexes WHERE ${indexKey}`, ...keys)),
    db.query(statement(`SELECT count(*) FILTER(WHERE state='indexed') AS indexedSources,
      count(*) FILTER(WHERE state='pending') AS pendingSources,
      count(*) FILTER(WHERE state<>'archived' AND issue IS NOT NULL) AS sourceIssues
      FROM onto_passage_sources WHERE ${indexKey}`, ...keys)),
    db.query(statement(`SELECT count(*) AS indexedPassages, count(*) FILTER(WHERE inferred=0) AS pendingPassages,
      count(*) FILTER(WHERE inferred=0 AND attempts>0) AS inferenceRetries
      FROM onto_passages WHERE ${indexKey}`, ...keys)),
    db.query(statement(`SELECT count(*) FILTER(WHERE state='routed') AS routed,
      count(*) FILTER(WHERE state='pending') AS pendingSuggestions, count(*) FILTER(WHERE state='unresolved') AS unresolved,
      count(*) FILTER(WHERE state='pending' AND attempts>0) AS routingRetries
      FROM onto_passage_suggestions WHERE ${indexKey}`, ...keys)),
  ]);
  return progressResult.parse({
    cursor: null, sweeps: 0, updatedAt: null, lastError: null, ...index, ...sources, ...passages, ...suggestions,
  });
}

const searchInput = scopeInput.extend({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(50).default(20),
  after: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const resultId = z.string().regex(/^[a-f0-9]{64}$/);
const searchResult = z.object({
  passages: z.array(z.object({ id: resultId, text: z.string(), locator, source: wikiSource })),
  next: resultId.nullable(),
});
async function search(who: AppIdentity, host: ReadHost, { wikiInstallationId: wiki, query, limit, after }: z.infer<typeof searchInput>) {
  const { db, keys } = scope(who, wiki);
  const rows = await db.query(statement(`SELECT p.id,p.text,p.locator,s.source FROM onto_passages p
    JOIN onto_passage_sources s USING(organizationId,wikiInstallationId,sourceId,version)
    WHERE p.organizationId=? AND p.wikiInstallationId=? AND p.id>? AND instr(p.searchText,?)>0
      AND s.state='indexed' ORDER BY p.id LIMIT ?`, ...keys, after ?? "", query.toLowerCase(), 101));
  const candidates = rows.slice(0, 100).map(row => ({
    id: String(row.id), text: String(row.text), locator: locator.parse(JSON.parse(String(row.locator))),
    source: wikiSource.parse(JSON.parse(String(row.source))),
  }));
  // Resolve under the searcher's own Wiki access, including when the index is empty.
  const active = await verifiedSources(host, who, wiki, [...new Map(candidates.map(p => [p.source.sourceId, p.source])).values()]);
  const matches = candidates.filter(row => active.has(row.source.sourceId));
  const passages = matches.slice(0, limit);
  return { passages, next: matches.length > limit ? passages.at(-1)!.id
    : rows.length > 100 ? candidates.at(-1)!.id : null };
}

type ActionContext = SDKActionContext & { host: () => WorkflowHost<"interactive"> };
const unresolvedInput = scopeInput.extend({ limit: z.number().int().min(1).max(50).default(20) });
export const passageIndexActions = {
  "passage.schedule": defineAction<ActionContext, typeof scopeInput, ReturnType<typeof z.json>>({
    description: "Enable this Onto installation's scheduled Wiki passage indexing as the acting organization editor.",
    access: "write", input: scopeInput, output: z.json(),
    run: async ({ identity, host }: ActionContext, input) => {
      await verifiedSources(host(), identity, input.wikiInstallationId, []);
      return host().call("schedule.save", { workflow: passageWorkflow, cron, timezone: "UTC", inputs: input, enabled: true });
    },
  }),
  "passage.search": defineAction<ActionContext, typeof searchInput, typeof searchResult>({
    description: "Search this organization's indexed Wiki passages with precise source revision and locator.",
    access: "read", input: searchInput, output: searchResult,
    run: ({ identity, host }: ActionContext, input) => search(identity, host(), input),
  }),
  "passage.progress": defineAction<ActionContext, typeof scopeInput, typeof progressResult>({
    description: "Read durable Wiki passage indexing and routing progress.",
    access: "read", input: scopeInput, output: progressResult,
    run: async ({ identity, host }: ActionContext, { wikiInstallationId: wiki }) => {
      await verifiedSources(host(), identity, wiki, []);
      return progress(scope(identity, wiki));
    },
  }),
  "passage.unresolved": defineAction<ActionContext, typeof unresolvedInput, ReturnType<typeof z.json>>({
    description: "Read current Wiki extraction issues and suggestions with unresolved evidence or anchors.",
    access: "read", input: unresolvedInput, output: z.json(),
    run: async ({ identity, host }: ActionContext, { wikiInstallationId: wiki, limit }) => {
      const { db, keys } = scope(identity, wiki);
      const [issues, suggestions] = await Promise.all([
        db.query(statement(`SELECT sourceId,version,issue FROM onto_passage_sources
          WHERE ${indexKey} AND state<>'archived' AND issue IS NOT NULL ORDER BY sourceId LIMIT ?`, ...keys, limit)),
        db.query(statement(`SELECT id,sourceId,version,passageId,plan,issue FROM onto_passage_suggestions
          WHERE ${indexKey} AND state='unresolved' ORDER BY id LIMIT ?`, ...keys, limit)),
      ]);
      const pins = [...new Map([...issues, ...suggestions].map(row => [String(row.sourceId), {
        sourceId: String(row.sourceId), version: String(row.version),
      }])).values()];
      const active = await verifiedSources(host(), identity, wiki, pins);
      return {
        sources: issues.filter(row => active.has(String(row.sourceId))),
        suggestions: suggestions.filter(row => active.has(String(row.sourceId)))
          .map(row => ({ ...row, plan: JSON.parse(String(row.plan)) })),
      };
    },
  }),
};

function supersede(where: string, params: unknown[]) {
  // Preserve decisions and prior citations. Only undecided batches lose their pending operation.
  const batches = `SELECT batchId FROM onto_passage_suggestions WHERE ${where} AND batchId IS NOT NULL`;
  return [
    ...closePassageBatches(batches, params, "source-superseded"),
    statement(`UPDATE onto_passage_suggestions SET state='superseded' WHERE ${where} AND state<>'superseded'`, ...params),
    statement(`DELETE FROM onto_passages WHERE ${where}`, ...params),
  ];
}

async function discover(worker: Worker, cursor: string | null, sweeps: number) {
  const inventory = sourceInventory.parse(await worker.host.call("actions.call", {
    installationId: worker.wiki, action: "passage.sources", readOnly: true,
    input: { ...(cursor ? { after: cursor } : {}), limit: selectSize },
  }));
  checkWikiOwner(worker.who, worker.wiki, inventory);
  let last = cursor ?? "";
  for (const row of inventory.sources) {
    checkWikiOwner(worker.who, worker.wiki, row);
    if (row.sourceId <= last) throw new Error("Wiki sources were returned out of order");
    last = row.sourceId;
  }
  if (inventory.next && (inventory.next <= (cursor ?? "") || inventory.next < last))
    throw new Error("Wiki source cursor did not advance");

  const seen = sweeps + 1;
  const { keys } = worker;
  const inventoryJson = JSON.stringify(inventory.sources);
  const replaced = `${indexKey} AND sourceId IN (
    SELECT s.sourceId FROM onto_passage_sources s
    JOIN json_each(?) item ON s.sourceId=json_extract(item.value,'$.sourceId')
    WHERE s.organizationId=? AND s.wikiInstallationId=? AND s.version<>json_extract(item.value,'$.version'))`;
  const missing = `${indexKey} AND sourceId IN (
    SELECT sourceId FROM onto_passage_sources WHERE ${indexKey} AND seen<>? AND state<>'archived')`;
  await worker.write(
    ...supersede(replaced, [...keys, inventoryJson, ...keys]),
    statement(`INSERT INTO onto_passage_sources(organizationId,wikiInstallationId,sourceId,version,source,seen,state)
      SELECT ?,?,json_extract(value,'$.sourceId'),json_extract(value,'$.version'),value,?,'pending'
      FROM json_each(?) WHERE true
      ON CONFLICT(organizationId,wikiInstallationId,sourceId) DO UPDATE SET
        version=excluded.version,
        source=CASE WHEN version=excluded.version AND state='indexed' THEN source ELSE excluded.source END,
        seen=excluded.seen,
        state=CASE WHEN version<>excluded.version OR state='archived' THEN 'pending' ELSE state END,
        issue=CASE WHEN version<>excluded.version OR state='archived' THEN NULL ELSE issue END,
        attempts=CASE WHEN version<>excluded.version OR state='archived' THEN 0 ELSE attempts END,
        retryAt=CASE WHEN version<>excluded.version OR state='archived' THEN 0 ELSE retryAt END`,
      ...keys, seen, inventoryJson),
    ...(inventory.next ? [] : [
      ...supersede(missing, [...keys, ...keys, seen]),
      statement(`UPDATE onto_passage_sources SET state='archived',issue=NULL WHERE ${indexKey} AND seen<>?`, ...keys, seen),
    ]),
    statement(`UPDATE onto_passage_indexes SET cursor=?,sweeps=? WHERE ${indexKey}`, inventory.next,
      inventory.next ? sweeps : seen, ...keys),
  );
  return inventory.next;
}

async function indexSources(worker: Worker) {
  const { db, keys, who, wiki, host } = worker;
  const queue = await db.query(statement(`SELECT source,attempts FROM onto_passage_sources
    WHERE ${indexKey} AND state='pending' AND retryAt<=? ORDER BY retryAt,sourceId LIMIT ?`, ...keys, Date.now(), sourceBudget));
  const extract = async (row: Record<string, unknown>) => {
    const pin = wikiSource.parse(JSON.parse(String(row.source)));
    const match = [...keys, pin.sourceId, pin.version];
    const sourceKey = `${indexKey} AND sourceId=? AND version=?`;
    try {
      const result = sourceRead.parse(await host.call("actions.call", {
        installationId: wiki, action: "passage.read",
        input: { sourceId: pin.sourceId, version: pin.version }, readOnly: true, maxResponseBytes: actionResponseBytes,
      }));
      if (result.state === "changed") {
        await worker.write(...supersede(sourceKey, match),
          statement(`UPDATE onto_passage_sources SET state='archived',issue=NULL WHERE ${sourceKey}`, ...match));
        return;
      }
      checkWikiOwner(who, wiki, result.source);
      if (pin.sourceId !== result.source.sourceId || pin.version !== result.source.version)
        throw new Error("Wiki returned an unpinned source version");
      const entries = await Promise.all(result.passages.map(async (passage, index) => ({
        ...passage, id: await sha256Hex(JSON.stringify([...keys, pin.sourceId, pin.version, index])),
        searchText: passage.text.toLowerCase(),
      })));
      // Each statement stays below D1's per-value budget, including worst-case Unicode.
      const insert: AgentStatement[] = [];
      for (let index = 0; index < entries.length; index += 100) {
        insert.push(statement(`INSERT INTO onto_passages(id,organizationId,wikiInstallationId,sourceId,version,text,searchText,locator)
          SELECT json_extract(value,'$.id'),?,?,?,?,json_extract(value,'$.text'),json_extract(value,'$.searchText'),json_extract(value,'$.locator')
          FROM json_each(?)`, ...match, JSON.stringify(entries.slice(index, index + 100))));
      }
      await worker.write(...insert,
        statement(`UPDATE onto_passage_sources SET state='indexed',source=?,issue=?,attempts=0,retryAt=0
          WHERE ${sourceKey}`, JSON.stringify(result.source), result.issue, ...match));
    } catch (error) {
      if (error instanceof Response && (error.status === 401 || error.status === 403)) throw error;
      const attempts = Number(row.attempts) + 1;
      await worker.write(statement(`UPDATE onto_passage_sources SET attempts=?,retryAt=?,issue=?
        WHERE ${sourceKey}`, attempts, retryAt(attempts), "Source extraction will be retried", ...match));
    }
  };
  for (let offset = 0; offset < queue.length && Date.now() < worker.startedAt + 4 * 60_000; offset += 4) {
    await Promise.allSettled(queue.slice(offset, offset + 4).map(extract)).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
  }
}

export async function passageOnSchedule(who: AppIdentity, host: WorkflowHost<"schedule">, raw: PhaseInput): Promise<PhaseInput> {
  requireEditor(who);
  const { schedule, runId } = scheduleInput.parse(raw);
  if (schedule.workflowId !== passageWorkflow || who.owner.kind !== "organization" || who.callerOrganizationId)
    return { outcome: "declined", reason: "An organization editor must own the Wiki passage schedule" };
  const { wikiInstallationId: wiki } = scopeInput.parse(schedule.inputs);
  await verifiedSources(host, who, wiki, []);
  const context = scope(who, wiki);
  const { db, keys } = context;
  const leaseId = crypto.randomUUID();
  const now = Date.now();
  const [lease] = await db.query(statement(`INSERT INTO onto_passage_indexes(organizationId,wikiInstallationId,leaseId,leaseUntil,updatedAt)
    VALUES(?,?,?,?,?) ON CONFLICT(organizationId,wikiInstallationId) DO UPDATE SET
    leaseId=excluded.leaseId,leaseUntil=excluded.leaseUntil,updatedAt=excluded.updatedAt
    WHERE leaseUntil IS NULL OR leaseUntil<=? RETURNING cursor,sweeps,reportRunId,report,reportCollected`, ...keys, leaseId, now + leaseMs, now, now));
  if (!lease) return { outcome: "declined", reason: "The Wiki passage index is already advancing" };

  const write: Worker["write"] = async (...writes) => {
    const guard = `passage-lease:${crypto.randomUUID()}`;
    await db.batch([
      statement(`INSERT INTO graph_changes(userId,requestKey,hash,attempt,receipt)
        VALUES(?,?,'passage lease',CASE WHEN EXISTS(SELECT 1 FROM onto_passage_indexes
        WHERE ${indexKey} AND leaseId=? AND leaseUntil>?) THEN ? END,'{}')`,
      who.userId, guard, ...keys, leaseId, Date.now(), guard),
      ...writes,
      statement("DELETE FROM graph_changes WHERE userId=? AND requestKey=?", who.userId, guard),
    ]);
  };
  const worker: Worker = { ...context, write, host, runId, startedAt: now };
  const collect = async (report: z.infer<typeof progressResult>) => {
    try {
      await host.call("workflow.collect", { runId, slot: progressSlot, value: report });
    } catch (error) {
      // Collection may have succeeded before a transport failure. The platform's
      // completed output is immutable, so compare it to the durable local report.
      if (!(error instanceof Response) || error.status !== 409) throw error;
      const run = await host.call("workflow.read", { id: runId });
      const output = run?.outputs[progressSlot];
      if (!output?.complete || JSON.stringify(progressResult.parse(output.value)) !== JSON.stringify(report)) throw error;
    }
    await write(statement(`UPDATE onto_passage_indexes SET reportCollected=1,lastError=NULL WHERE ${indexKey} AND reportRunId=?`,
      ...keys, runId));
  };
  try {
    if (lease.reportRunId === runId) {
      if (!lease.reportCollected) await collect(progressResult.parse(JSON.parse(String(lease.report))));
      return { outcome: "started" };
    }
    const started = await host.call("workflow.start", { workflow: passageWorkflow, id: runId, inputs: {} });
    if (!started.created) {
      const previous = await host.call("workflow.read", { id: runId });
      if (previous?.outputs[progressSlot]?.complete) return { outcome: "started" };
    }
    let cursor = lease.cursor === null ? null : String(lease.cursor);
    for (let page = 0; page < 4; page++) {
      cursor = await discover(worker, cursor, Number(lease.sweeps));
      if (!cursor) break;
    }
    await indexSources(worker);
    const onto = installationDatabase();
    await routePassageSuggestions(worker, onto);
    await inferPassages(worker, onto);
    await routePassageSuggestions(worker, onto);
    await write(statement(`UPDATE onto_passage_indexes SET updatedAt=?,lastError=NULL WHERE ${indexKey}`, Date.now(), ...keys));
    const report = await progress(context);
    await write(statement(`UPDATE onto_passage_indexes SET reportRunId=?,report=?,reportCollected=0 WHERE ${indexKey}`,
      runId, JSON.stringify(report), ...keys));
    await collect(report);
    return { outcome: "started" };
  } catch (error) {
    await write(statement(`UPDATE onto_passage_indexes SET lastError=?,updatedAt=? WHERE ${indexKey}`,
      error instanceof Response ? `Passage run failed (HTTP ${error.status})` : "Passage run failed",
      Date.now(), ...keys)).catch(() => undefined);
    throw error;
  } finally {
    await db.batch([statement(`UPDATE onto_passage_indexes SET leaseId=NULL,leaseUntil=NULL
      WHERE ${indexKey} AND leaseId=?`, ...keys, leaseId)]);
  }
}
