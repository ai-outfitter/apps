// Project-driven delivery (docs/plans/project-delivery-flow.md): MutateProject saves a project,
// its requirement revisions and a preparation intent in one batch, then starts the registered
// planning-delivery-prepare task. Preparation is never execution: packages are proposals, and
// submission, approval and acceptance keep their own authority.
import { canonicalActionValue } from "@ai-outfitter/app-sdk/actions";
import { requireEditor, sha256Hex } from "@ai-outfitter/app-sdk/server";
import { z } from "zod";
import { projectFields } from "./fields";
import type { PlanningContext } from "./intake";
import { projectBase } from "./planning";
import {
  type RequirementChange, type RequirementInput, planRequirementChanges, requirementInput, requirementList, type StoredRequirement,
} from "./requirements";

export const preparationTask = "planning-delivery-prepare";
type Statement = { sql: string; params?: unknown[] };
const changed = () => new Response("This record changed. Your draft is preserved; reload before retrying.", { status: 409 });
const guard: Statement[] = [
  { sql: "INSERT INTO planning_work_guard(value) VALUES(CASE WHEN changes()=1 THEN 1 ELSE NULL END)" },
  { sql: "DELETE FROM planning_work_guard" },
];

/** A UUID derived from its parts, so the same project revision always names the same intent. */
export async function stableId(...parts: unknown[]) {
  const h = await sha256Hex(canonicalActionValue(parts));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type PreparationState = "queued" | "dispatched" | "dispatch_failed" | "running" | "prepared" | "blocked" | "superseded" | "failed";
export type PreparationRow = {
  id: string; projectId: string; projectRevision: number; state: PreparationState; changes: PreparationChanges; dispatchError: string | null;
  plan: Record<string, unknown> | null; revision: number; createdAt: number; updatedAt: number;
};
/** What a preparation answers: every active requirement at its revision, and what changed. */
export type PreparationChanges = { requirements: { id: string; key: string; revision: number }[]; changed: RequirementChange[] };

export async function loadRequirements(c: PlanningContext, projectId: string): Promise<StoredRequirement[]> {
  const rows = await c.store().query({
    sql: "SELECT id,key,revision,retired,body,actionDigest FROM planning_requirements WHERE installationId=? AND projectId=? ORDER BY key",
    params: [c.identity.installationId, projectId],
  });
  return rows.map((row) => ({ id: String(row.id), key: String(row.key), revision: Number(row.revision), retired: Boolean(Number(row.retired)), body: requirementInput.parse(JSON.parse(String(row.body))), actionDigest: String(row.actionDigest) }));
}
const preparationRow = (row: Record<string, unknown>): PreparationRow => ({
  id: String(row.id), projectId: String(row.projectId), projectRevision: Number(row.projectRevision), state: row.state as PreparationState,
  changes: JSON.parse(String(row.changes)), dispatchError: row.dispatchError == null ? null : String(row.dispatchError),
  plan: row.plan == null ? null : JSON.parse(String(row.plan)), revision: Number(row.revision), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
});
export async function getPreparation(c: PlanningContext, id: string) {
  const [row] = await c.store().query({ sql: "SELECT * FROM planning_preparations WHERE installationId=? AND id=?", params: [c.identity.installationId, id] });
  return row ? preparationRow(row) : null;
}
export async function latestPreparation(c: PlanningContext, projectId: string) {
  const [row] = await c.store().query({ sql: "SELECT * FROM planning_preparations WHERE installationId=? AND projectId=? ORDER BY projectRevision DESC LIMIT 1", params: [c.identity.installationId, projectId] });
  return row ? preparationRow(row) : null;
}
/** Compare-and-set on the preparation's own revision. */
export async function updatePreparation(c: PlanningContext, prep: PreparationRow, patch: Partial<Pick<PreparationRow, "state" | "dispatchError" | "plan">>) {
  const next = { ...prep, ...patch };
  await c.store().batch([
    { sql: "UPDATE planning_preparations SET state=?,dispatchError=?,plan=?,revision=revision+1,updatedAt=? WHERE id=? AND installationId=? AND revision=?",
      params: [next.state, next.dispatchError, next.plan ? JSON.stringify(next.plan) : null, Date.now(), prep.id, c.identity.installationId, prep.revision] },
    ...guard,
  ]).catch(() => { throw new Response("Preparation changed; read it again", { status: 409 }); });
  return (await getPreparation(c, prep.id))!;
}

/** The preparation summary MutateProject answers and ProjectDelivery reads. */
export function preparationSummary(prep: PreparationRow | null) {
  if (!prep) return null;
  const plan = prep.plan ?? {};
  return {
    id: prep.id, projectRevision: prep.projectRevision, state: prep.state, dispatchError: prep.dispatchError,
    intakeId: (plan.intakeId as string | undefined) ?? null,
    changed: prep.changes.changed.filter((change) => change.actionable),
    packages: (plan.packages as unknown[] | undefined) ?? [],
    questions: (plan.questions as unknown[] | undefined) ?? [],
    conflicts: (plan.conflicts as unknown[] | undefined) ?? [],
    blockers: (plan.blockers as unknown[] | undefined) ?? [],
  };
}

/** Start (or, after a lost response or refusal, restart) the preparation task under its own id.
 * The platform treats an identical start as the same run. A failure is recorded, never thrown:
 * the project change it follows is already saved. */
export async function dispatchPreparation(c: PlanningContext, prep: PreparationRow) {
  if (!["queued", "dispatch_failed"].includes(prep.state)) return prep;
  try {
    await c.host().call("task.start", { task: preparationTask, id: prep.id, inputs: { preparationId: prep.id } });
    return await updatePreparation(c, prep, { state: "dispatched", dispatchError: null });
  } catch (error) {
    const message = error instanceof Response ? `${error.status}: ${(await error.text()).slice(0, 500)}` : error instanceof Error ? error.message.slice(0, 500) : "Task dispatch unavailable";
    try { return await updatePreparation(c, prep, { state: "dispatch_failed", dispatchError: message }); }
    catch { return { ...prep, state: "dispatch_failed" as const, dispatchError: message }; }
  }
}

const columns = ["name", "githubRepository", "goals", "userStories", "pressRelease", "demoInstructions", "demoResults"] as const;
type ProjectFields = z.output<typeof projectFields>;
type ProjectChange =
  | { kind: "create"; fields: ProjectFields; requirements: RequirementInput[] }
  | { kind: "edit"; project: { id: string; revision: number }; mask: Partial<ProjectFields>; requirements: RequirementInput[]; retire: string[] };

function projectStatement(change: ProjectChange, projectId: string, revision: number, user: string, installation: string, now: number): Statement[] {
  if (change.kind === "create") return [{ sql: `INSERT INTO planning_projects(id,installationId,${columns.join(",")},archived,revision,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,${columns.map(() => "?").join(",")},0,1,?,?,?,?)`,
    params: [projectId, installation, ...columns.map((column) => change.fields[column]), user, user, now, now] }];
  const set = columns.filter((column) => change.mask[column] !== undefined);
  return [{ sql: `UPDATE planning_projects SET ${set.map((column) => `${column}=?,`).join("")}revision=?,updatedBy=?,updatedAt=? WHERE id=? AND installationId=? AND revision=? AND archived=0`,
    params: [...set.map((column) => change.mask[column]), revision, user, now, projectId, installation, change.project.revision] }, ...guard];
}

function requirementStatements(writes: { row: StoredRequirement; insert: boolean }[], projectId: string, revision: number, user: string, installation: string, now: number): Statement[] {
  return writes.flatMap(({ row, insert }) => {
    const body = JSON.stringify(row.body);
    const save: Statement[] = insert
      ? [{ sql: "INSERT INTO planning_requirements(id,installationId,projectId,key,retired,body,actionDigest,revision,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,?,0,?,?,1,?,?,?,?)",
        params: [row.id, installation, projectId, row.key, body, row.actionDigest, user, user, now, now] }]
      : [{ sql: "UPDATE planning_requirements SET retired=?,body=?,actionDigest=?,revision=?,updatedBy=?,updatedAt=? WHERE id=? AND installationId=? AND revision=?",
        params: [row.retired ? 1 : 0, body, row.actionDigest, row.revision, user, now, row.id, installation, row.revision - 1] }, ...guard];
    return [...save, { sql: "INSERT INTO planning_requirement_revisions(requirementId,revision,projectRevision,retired,body,actionDigest,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      params: [row.id, row.revision, revision, row.retired ? 1 : 0, body, row.actionDigest, user, now] }];
  });
}

/** A save that changes nothing actionable still retries the latest intent that failed to dispatch. */
async function dispatchAfterSave(c: PlanningContext, projectId: string, preparationId: string | null) {
  const prep = preparationId ? await getPreparation(c, preparationId) : null;
  if (prep) return dispatchPreparation(c, prep);
  const latest = await latestPreparation(c, projectId);
  return latest?.state === "dispatch_failed" ? dispatchPreparation(c, latest) : null;
}

/** Save the project change, its requirement revisions and, when an actionable requirement
 * changed, the preparation intent, in one batch guarded by the project revision. */
export async function saveProjectChange(c: PlanningContext, change: ProjectChange) {
  const now = Date.now(), user = c.identity.userId, installation = c.identity.installationId;
  const projectId = change.kind === "create" ? crypto.randomUUID() : change.project.id;
  const revision = change.kind === "create" ? 1 : change.project.revision + 1;
  const current = change.kind === "create" ? [] : await loadRequirements(c, projectId);
  const { writes, changes } = await planRequirementChanges(current, change.requirements, change.kind === "edit" ? change.retire : []);
  const statements = [...projectStatement(change, projectId, revision, user, installation, now), ...requirementStatements(writes, projectId, revision, user, installation, now)];
  let preparationId: string | null = null;
  if (changes.some((item) => item.actionable)) {
    preparationId = await stableId("planning-preparation", installation, projectId, revision);
    const written = new Map(writes.map(({ row }) => [row.id, row]));
    const active = [...current.filter((row) => !written.has(row.id)), ...writes.map(({ row }) => row)].filter((row) => !row.retired);
    const prepared: PreparationChanges = { requirements: active.map((row) => ({ id: row.id, key: row.key, revision: row.revision })).sort((a, b) => a.key.localeCompare(b.key)), changed: changes };
    // An older intent that never ran answers requirements that no longer hold.
    statements.push({ sql: "UPDATE planning_preparations SET state='superseded',revision=revision+1,updatedAt=? WHERE installationId=? AND projectId=? AND state IN ('queued','dispatch_failed')", params: [now, installation, projectId] });
    statements.push({ sql: "INSERT INTO planning_preparations(id,installationId,projectId,projectRevision,state,changes,revision,createdBy,createdAt,updatedAt) VALUES(?,?,?,?,'queued',?,1,?,?,?)",
      params: [preparationId, installation, projectId, revision, JSON.stringify(prepared), user, now, now] });
  }
  try { await c.store().batch(statements); }
  catch (error) {
    if (change.kind === "edit") throw changed();
    throw error instanceof Response ? error : new Response("Cannot save the project and its requirements", { status: 409 });
  }
  return { projectId, requirementChanges: changes, preparation: await dispatchAfterSave(c, projectId, preparationId) };
}

/** The extra MutateProject result fields: what changed, the preparation and its run. */
export function deliveryResult(saved: Awaited<ReturnType<typeof saveProjectChange>>, projectRevision: number) {
  const prep = saved.preparation;
  const instructions = prep?.state === "dispatch_failed" ? [{
    code: "RETRY_PREPARATION", actor: "caller", required: true,
    message: `The project was saved, but preparation could not start (${prep.dispatchError}). Retry it with this call under a new key.`,
    call: { document: "MutateProject", item: { action: "prepare", input: { project: { id: saved.projectId, revision: projectRevision } } } },
  }] : [];
  return {
    requirementChanges: saved.requirementChanges,
    preparation: preparationSummary(prep),
    run: prep && ["dispatched", "running"].includes(prep.state) ? { id: prep.id, status: "queued" } : null,
    instructions,
  };
}

export const prepareInput = z.strictObject({ project: projectBase });
/** MutateProject `prepare`: retry the intent for the named project revision (or the latest one
 * still outstanding). Starts nothing new for a revision without an actionable change. */
export async function prepareProject(c: PlanningContext, { project }: z.output<typeof prepareInput>) {
  requireEditor(c.identity);
  const id = await stableId("planning-preparation", c.identity.installationId, project.id, project.revision);
  let prep = (await getPreparation(c, id)) ?? (await latestPreparation(c, project.id));
  if (!prep) throw new Response("No requirement change to prepare at this revision", { status: 409 });
  if (prep.state === "failed") prep = await updatePreparation(c, prep, { state: "dispatch_failed", dispatchError: "Retrying after a failed run" });
  prep = await dispatchPreparation(c, prep);
  return { projectId: project.id, requirementChanges: [], preparation: prep };
}

export const createWithRequirements = projectFields.extend({ requirements: requirementList.default([]) });
