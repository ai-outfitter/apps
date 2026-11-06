import type { ProviderInput, ProviderOutput, ThreadPart, ThreadTypeDescriptor } from "@ai-outfitter/app-sdk/threads";
import type { OperationOutput, WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { threadArtifactPath, threadRefKey } from "@ai-outfitter/app-sdk/threads";
import { z } from "zod";
import { runLabel } from "./home-cards";

/**
 * Software Foundry's read-only workflow history provider. It projects the
 * authoritative records the workflow host already keeps (run inputs, outputs,
 * attempts, status and retained session archive references) into the common
 * thread timeline on every read. Nothing is copied into a second execution log,
 * and nothing here can start, resume, cancel or change a run: the provider
 * declares only list/get/entries and calls only read operations.
 *
 * Source IDs are stable: the same run, attempt or output slot always projects
 * to the same entry ID. Timestamps appear only where the source recorded one;
 * output slots and the current status have none, and a run's `updatedAt` is not
 * presented as a completion time.
 */

export const runType = "software-foundry.workflow-run";
/** The run creator's workspace progress on an attempt, as the workflow host reports it. */
export const progressPart = "software-foundry.progress";
const progressSchema = {
  type: "object", required: ["workspace", "run", "toolCount", "tools", "observedAt"],
  properties: {
    workspace: { type: "string", maxLength: 32 }, run: { type: "string", maxLength: 32 },
    toolCount: { type: "integer", minimum: 0 },
    tools: { type: "array", maxItems: 100, items: { type: "object", required: ["name", "label", "status"], properties: {
      name: { type: "string", maxLength: 40 }, label: { type: "string", maxLength: 160 }, status: { enum: ["running", "completed", "failed"] } } } },
    note: { type: "string", maxLength: 240 }, observedAt: { type: "integer" },
  },
};
export const sessionType = "software-foundry.session";
export const historyTypes: ThreadTypeDescriptor[] = [
  { type: runType, version: 1, label: "Foundry workflow run", kind: "history", operations: ["list", "get", "entries"], parts: [progressPart],
    schemas: [{ name: progressPart, version: 1, kind: "part", title: "Workspace progress (run creator only)", schema: progressSchema }] },
  { type: sessionType, version: 1, label: "Foundry retained session", kind: "history", operations: ["get", "entries"] },
];

type Host = WorkflowHost<"interactive">;
type Read = NonNullable<OperationOutput<"workflow.read">>;
type Artifact = OperationOutput<"artifacts.describe">[number];
type Entry = ProviderOutput<"entries">["entries"][number];
type Item = NonNullable<ProviderOutput<"get">>;
type Identity = { installationId: string; owner: { kind: "organization" | "user" } };

const artifactRef = z.object({ id: z.uuid(), runId: z.string().min(1) });
type Cite = { key: string; nodeId: string; entryId: string; ref: z.infer<typeof artifactRef> | null; recordedAt?: number; updatedAt?: number };

/** The engine's derived run status, as the run page shows it. */
export function runStatus(record: Pick<Read, "run" | "readiness">) {
  return record.run.status === "failed" ? "failed" : record.readiness.run;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Session archives the record cites: failed attempts' receipts and finalized output rows. */
export function citedSessions(record: Read): Cite[] {
  const runId = record.run.id;
  const own = (ref: z.infer<typeof artifactRef>) => ref.runId === runId || ref.runId === record.inputs["land.inputs.sourceRunId"];
  const cited: Cite[] = [];
  for (const attempt of record.attempts)
    if (attempt.sessionArtifact && own(attempt.sessionArtifact))
      cited.push({ key: attempt.id, nodeId: attempt.nodeId, entryId: `${runId}:attempt:${attempt.id}`, ref: attempt.sessionArtifact, recordedAt: attempt.createdAt, updatedAt: attempt.updatedAt });
  for (const [slot, row] of Object.entries(record.outputs)) {
    const value = object(row.value);
    if (value.sessionArtifact === undefined || value.sessionArtifact === null) continue;
    const ref = artifactRef.safeParse(value.sessionArtifact);
    // A malformed or foreign reference is shown as missing evidence, never followed.
    cited.push({ key: slot, nodeId: slot.split(".")[0], entryId: `${runId}:output:${slot}`, ref: ref.success && own(ref.data) ? ref.data : null });
  }
  return cited;
}

/**
 * The read path of a run artifact cited by this run's history thread. The
 * platform first checks the caller can read the thread through this provider,
 * then applies the SOURCE installation's artifact rules (capability, fresh
 * membership, owner-only workflows), so the link works from any app or mount
 * that shows the timeline. `download` answers a redirect to a short-lived URL.
 */
export function artifactPath(identity: Identity, runId: string, artifactId: string) {
  return threadArtifactPath(runRef(identity, runId), artifactId, true);
}

function artifactPart(identity: Identity, runId: string, cite: Cite, metadata: Map<string, Artifact>, now: number): Extract<ThreadPart, { type: "artifact" }> {
  // Archives are packaged files; this timeline links them but does not parse a transcript from them.
  const name = `${cite.nodeId} session archive (download only)`;
  if (!cite.ref) return { type: "artifact", name, availability: "missing" };
  const found = metadata.get(cite.ref.id);
  const base = { type: "artifact" as const, name, artifactId: cite.ref.id };
  if (!found) return { ...base, availability: "missing" };
  if (found.expiresAt <= now) return { ...base, contentType: found.contentType, availability: "expired" };
  if (found.state !== "ready") return { ...base, contentType: found.contentType, availability: "incomplete" };
  return { ...base, contentType: found.contentType, url: artifactPath(identity, runId, cite.ref.id), availability: "available" };
}

/** Host metadata for every cited archive; ids the host omits are missing or swept. */
async function describe(host: Host, record: Read, cited: Cite[]) {
  const byRun = new Map<string, Set<string>>();
  for (const cite of cited) if (cite.ref) byRun.set(cite.ref.runId, (byRun.get(cite.ref.runId) ?? new Set()).add(cite.ref.id));
  const metadata = new Map<string, Artifact>();
  for (const [runId, ids] of byRun) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 50)
      for (const item of await host.call("artifacts.describe", { runId, ids: list.slice(i, i + 50) }))
        metadata.set(item.id, item);
  }
  return metadata;
}

const sessionRef = (identity: Identity, runId: string, key: string) =>
  ({ installationId: identity.installationId, type: sessionType, sourceId: `${runId}:${key}` });
const runRef = (identity: Identity, runId: string) => ({ installationId: identity.installationId, type: runType, sourceId: runId });

/** The run timeline, oldest first: inputs, attempts (recorded order), outputs (step order), current status. */
export function projectRun(record: Read, identity: Identity, artifacts: Map<string, Artifact>, options: { steps?: string[]; now?: number } = {}): Entry[] {
  const now = options.now ?? Date.now();
  const runId = record.run.id;
  const workflow = { kind: "app" as const, id: identity.installationId, label: record.run.workflowId };
  const member = { kind: "member" as const, id: record.run.createdBy };
  const entries: Entry[] = [];
  const add = (sourceId: string, parts: ThreadPart[], actor: typeof workflow | typeof member, recordedAt: number | null) =>
    entries.push({
      id: sourceId, role: "event", parts, status: "complete", submissionId: null, sourceKey: sourceId,
      attribution: { actor, origin: member, userId: record.run.createdBy, installationId: identity.installationId },
      metadata: null,
      // Ordering key only: provider entries are ordered by their projection sequence.
      createdAt: entries.length,
      recordedAt,
    });
  add(`${runId}:inputs`, Object.keys(record.inputs).length
    ? Object.entries(record.inputs).map(([name, value]) => ({ type: "workflow-input" as const, name, value }))
    : [{ type: "text", text: "This run recorded no inputs." }], member, record.run.createdAt);
  const cited = citedSessions(record);
  const sessionParts = (key: string) => cited.filter((cite) => cite.key === key).flatMap((cite): ThreadPart[] => {
    const part = artifactPart(identity, runId, cite, artifacts, now);
    return part.availability === "missing" && !cite.ref ? [part] : [part, { type: "thread-link", ref: sessionRef(identity, runId, cite.key), relation: "session", title: part.name }];
  });
  const attempts = [...record.attempts].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const attempt of attempts) {
    const parts: ThreadPart[] = [{
      type: "attempt", attemptId: attempt.id, nodeId: attempt.nodeId, state: attempt.state,
      ...(attempt.failure ? { failure: attempt.failure } : {}), createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
    }, ...sessionParts(attempt.id)];
    if (attempt.state === "uncertain")
      parts.push({ type: "text", text: "The outcome of this attempt was not confirmed. Inspect the provider before retrying." });
    // Present only when the host returned it: the run creator's own progress.
    if (attempt.progress) parts.push({ type: "data", name: progressPart, version: 1, data: attempt.progress });
    add(`${runId}:attempt:${attempt.id}`, parts, workflow, attempt.createdAt);
  }
  const order = options.steps ?? [];
  const rank = (slot: string) => { const index = order.indexOf(slot.split(".")[0]); return index < 0 ? order.length : index; };
  for (const [slot, row] of Object.entries(record.outputs).sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))) {
    const parts: ThreadPart[] = [{ type: "workflow-output", name: slot, value: row.value, complete: row.complete }, ...sessionParts(slot)];
    if (!row.complete) parts.push({ type: "text", text: "This output is incomplete." });
    add(`${runId}:output:${slot}`, parts, workflow, null);
  }
  const status = runStatus(record);
  add(`${runId}:status`, [
    { type: "status", status, label: status, detail: Object.entries(record.readiness.steps).map(([step, state]) => `${step}: ${state}`).join(", ").slice(0, 4000) || undefined },
    ...(status === "running" ? [{ type: "text" as const, text: "This run has not finished; later steps may still change." }] : []),
  ], workflow, null);
  return entries;
}

/** A retained session's child timeline: its archive reference and the attempt or output that cites it. */
export function projectSession(record: Read, key: string, identity: Identity, artifacts: Map<string, Artifact>, now = Date.now()): Entry[] | null {
  const cite = citedSessions(record).find((item) => item.key === key);
  if (!cite) return null;
  const part = artifactPart(identity, record.run.id, cite, artifacts, now);
  const explanation = {
    available: "The retained session archive is available to download. It is download-only evidence: its session transcript is not parsed into this timeline.",
    missing: "The retained session archive is missing.",
    expired: "The retained session archive has expired.",
    incomplete: "The retained session archive was not completely stored.",
  }[part.availability];
  const member = { kind: "member" as const, id: record.run.createdBy };
  return [{
    id: `${record.run.id}:session:${key}`, role: "event", status: "complete", submissionId: null, sourceKey: `${record.run.id}:session:${key}`,
    parts: [part, { type: "text", text: explanation }, { type: "thread-link", ref: runRef(identity, record.run.id), relation: "parent", title: record.run.workflowId }],
    attribution: { actor: { kind: "app", id: identity.installationId, label: record.run.workflowId }, origin: member, userId: record.run.createdBy, installationId: identity.installationId },
    metadata: null, createdAt: 0, recordedAt: cite.recordedAt ?? null,
  }];
}

function page(entries: Entry[], input: { before?: string; after?: string; limit: number }) {
  const limit = Math.max(1, Math.min(200, input.limit));
  const position = (cursor: string | undefined) => (cursor === undefined ? undefined : Number.parseInt(cursor, 10));
  const after = position(input.after), before = position(input.before);
  let start: number, end: number;
  if (after !== undefined && Number.isFinite(after)) { start = after + 1; end = Math.min(entries.length, start + limit); }
  else { end = before !== undefined && Number.isFinite(before) ? Math.max(0, before) : entries.length; start = Math.max(0, end - limit); }
  return {
    entries: entries.slice(start, end),
    before: start > 0 ? String(start) : null,
    after: end < entries.length ? String(end - 1) : null,
  };
}

const cursor = z.object({ updatedAt: z.number().int(), id: z.string().min(1).max(128) });
const encodeCursor = (value: z.infer<typeof cursor>) => btoa(JSON.stringify(value));
function decodeCursor(value: string | undefined) {
  if (!value) return undefined;
  try { return cursor.parse(JSON.parse(atob(value))); } catch { throw new Response("Invalid cursor", { status: 400 }); }
}

const labelSlots = ["triage.inputs.event", "land.inputs.event", "triage.inputs.issue"];

/** A run's thread visibility: an owner-only source stays private wherever it is read. */
function visibility(identity: Identity, source: "owner" | "organization" = "organization") {
  return identity.owner.kind === "organization" && source !== "owner" ? "organization" as const : "private" as const;
}

/** The provider callbacks, bound to one request's host and identity. */
export function workflowHistory(host: Host, identity: Identity) {
  async function read(runId: string) {
    return host.call("workflow.read", { id: runId });
  }
  function runItem(run: { id: string; workflowId: string; createdBy: string; createdAt: number; updatedAt: number; visibility?: "owner" | "organization"; inputs?: Record<string, unknown> }, status: string): Item {
    const label = runLabel({ inputs: (run.inputs ?? {}) as Parameters<typeof runLabel>[0]["inputs"] });
    return {
      sourceId: run.id, type: runType, typeVersion: 1, createdBy: run.createdBy, visibility: visibility(identity, run.visibility),
      title: `${label.title} · ${run.workflowId} · ${status}`.slice(0, 200), status: "active", context: null, parent: null,
      createdAt: run.createdAt, updatedAt: run.updatedAt,
    };
  }
  /** A retained session cited by one of the run's attempts, as its own read-only history. */
  async function sessionItem(sourceId: string): Promise<ProviderOutput<"get">> {
    const parts = split(sourceId);
    const record = parts && await read(parts.runId);
    const cite = record && parts ? citedSessions(record).find((item) => item.key === parts.key) : undefined;
    if (!record || !cite) return null;
    return {
      sourceId, type: sessionType, typeVersion: 1, createdBy: record.run.createdBy, visibility: visibility(identity, record.run.visibility),
      title: `${cite.nodeId} session · ${record.run.workflowId}`.slice(0, 200), status: "active", context: null,
      parent: { id: threadRefKey(runRef(identity, record.run.id)), entryId: cite.entryId },
      createdAt: cite.recordedAt ?? record.run.createdAt, updatedAt: cite.updatedAt ?? record.run.updatedAt,
    };
  }
  function split(sourceId: string) {
    const index = sourceId.indexOf(":");
    if (index < 1) return null;
    return { runId: sourceId.slice(0, index), key: sourceId.slice(index + 1) };
  }
  return {
    async list(input: ProviderInput<"list">): Promise<ProviderOutput<"list">> {
      if (input.type !== runType) return { threads: [], cursor: null };
      const before = decodeCursor(input.cursor);
      const limit = Math.max(1, Math.min(20, input.limit));
      const activity = await host.call("workflow.activity", { slots: labelSlots, limit, ...(before ? { before } : {}) });
      const last = activity.items.at(-1);
      return {
        threads: activity.items.map((run) => runItem(run, run.status)),
        cursor: activity.items.length === limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      };
    },
    async get(input: ProviderInput<"get">): Promise<ProviderOutput<"get">> {
      if (input.type === runType) {
        const record = await read(input.sourceId);
        return record ? runItem({ ...record.run, inputs: record.inputs }, runStatus(record)) : null;
      }
      return input.type === sessionType ? sessionItem(input.sourceId) : null;
    },
    async entries(input: ProviderInput<"entries">): Promise<ProviderOutput<"entries">> {
      if (input.type === runType) {
        const record = await read(input.sourceId);
        if (!record) throw new Response("Workflow run not found", { status: 404 });
        const artifacts = await describe(host, record, citedSessions(record));
        return page(projectRun(record, identity, artifacts, { steps: Object.keys(record.readiness.steps) }), input);
      }
      const parts = input.type === sessionType ? split(input.sourceId) : null;
      const record = parts && await read(parts.runId);
      if (!record || !parts) throw new Response("Session not found", { status: 404 });
      const entries = projectSession(record, parts.key, identity, await describe(host, record, citedSessions(record).filter((cite) => cite.key === parts.key)));
      if (!entries) throw new Response("Session not found", { status: 404 });
      return page(entries, input);
    },
  };
}
