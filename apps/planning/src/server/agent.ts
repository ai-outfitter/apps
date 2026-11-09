import type { FieldOptions } from "@ai-outfitter/app-sdk/agent-context";
import { drizzlePatch, schemaJSON } from "@ai-outfitter/app-sdk/agent-schema";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { ThreadPart } from "@ai-outfitter/app-sdk/threads";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { z } from "zod";
import { issueFields, projectFields } from "./fields";
import { validateAssignee } from "./planning";
import { type BatchDatabase, type ProposalRow, ProposalStore, type Statement } from "./proposals";
import { issues, projects } from "./schema";

/**
 * Planning's reviewed agent proposals: exact targets, revisions, schemas and
 * approved domain writes. Conversations and transcripts belong to the platform
 * thread service; this module never stores messages. A proposal is a private
 * domain draft of the member who requested it, scoped to this installation.
 */

export const projectPatch = drizzlePatch(projects, projectFields);
export const issuePatch = drizzlePatch(issues, issueFields.omit({ projectId: true }));
const issueCreate = issueFields.omit({ projectId: true });
export const actionInputs = {
  create_project: projectFields,
  create_project_issue: issueFields,
  amend_project: projectPatch,
  create_issue: issueCreate,
  amend_issue: z.strictObject({ targetId: z.uuid(), changes: issuePatch }),
};
export type ActionName = keyof typeof actionInputs;
export const actionNames = Object.keys(actionInputs) as ActionName[];
export const actions = Object.entries(actionInputs).map(([id, schema]) => ({
  id,
  label: id.replaceAll("_", " "),
  schema: schemaJSON(schema),
}));
export const intakeActions = actions.filter((a) => ["create_project", "create_project_issue"].includes(a.id));

export function fields<S extends z.ZodRawShape>(schema: z.ZodObject<S>, row: Record<string, unknown>) {
  return schema.parse(Object.fromEntries(Object.keys(schema.shape).filter((key) => key in row).map((key) => [key, row[key]])));
}
export type RecordRow = Record<string, unknown>;
type ProposalData = {
  action: "create_project" | "amend_project" | "create_issue" | "amend_issue";
  targetId: string;
  targetLabel: string;
  targetRevision: number;
  projectId: string;
  projectRevision: number;
  parentRevision?: number;
  changes: RecordRow;
  before: RecordRow;
  schema: ReturnType<typeof schemaJSON>;
  fieldOptions?: FieldOptions;
};
/** The browser view of one proposal; display data, never authority. */
export type ProposalView = Omit<ProposalData, "projectRevision" | "parentRevision"> & {
  id: string;
  threadId: string;
  revision: number;
  status: ProposalRow["status"];
  receipt?: unknown;
  /** False until the decision is recorded on the conversation timeline. */
  timelineSynced: boolean;
};

function proposalLabel(action: string, target: RecordRow, changes: RecordRow, p: RecordRow) {
  return String(action === "create_issue" ? `${changes.title} — ${p.name}` : (target.name ?? target.title));
}

/** The timeline link for a proposal; derived only from stored values, so retries are identical. */
export function proposalPart(installationId: string, row: ProposalRow): Extract<ThreadPart, { type: "proposal" }> {
  const data = JSON.parse(row.data) as ProposalData;
  return {
    type: "proposal",
    installationId,
    proposalId: row.id,
    action: data.action,
    label: String(data.targetLabel ?? data.targetId).slice(0, 200),
    status: row.status,
    revision: Number(row.revision),
  };
}

export function planningProposals(
  db: BatchDatabase,
  identity: AppIdentity,
  memberIds: readonly string[] | undefined,
  host?: WorkflowHost<"interactive">,
) {
  const store = new ProposalStore(db, identity);
  const query = (sql: string, params: unknown[] = []) => db.query({ sql, params });
  async function row(table: "planning_projects" | "planning_issues", id: string) {
    const found = (await query(`SELECT * FROM ${table} WHERE id=? AND installationId=?`, [id, identity.installationId]))[0];
    if (!found) throw new Response("Record not found", { status: 404 });
    return found;
  }
  const project = (id: string) => row("planning_projects", z.uuid().parse(id));
  function view(saved: ProposalRow): ProposalView {
    const { projectRevision: _p, parentRevision: _r, ...data } = JSON.parse(saved.data) as ProposalData;
    return {
      ...data,
      id: saved.id,
      threadId: saved.threadId,
      revision: Number(saved.revision),
      status: saved.status,
      ...(saved.receipt ? { receipt: JSON.parse(saved.receipt) } : {}),
      timelineSynced: Boolean(saved.timelineEntryId),
    };
  }
  async function parentRevisionFor(merged: RecordRow, projectId: string, targetId: unknown, previousAssignee: unknown) {
    let parentRevision: number | undefined;
    validateAssignee(merged.assigneeId as string | null | undefined, memberIds, previousAssignee);
    if ("parentId" in merged && merged.parentId) {
      const parent = await row("planning_issues", String(merged.parentId));
      if (parent.projectId !== projectId || parent.id === targetId) throw new Response("Invalid parent", { status: 400 });
      parentRevision = Number(parent.revision);
    }
    return parentRevision;
  }
  async function proposalOptions(action: string, projectId: string, targetId: unknown) {
    if (action === "amend_project") return undefined;
    const parents = await query(
      "SELECT id,title FROM planning_issues WHERE installationId=? AND projectId=? AND id<>? ORDER BY position,id LIMIT 200",
      [identity.installationId, projectId, targetId],
    );
    return { parentId: [{ value: null, label: "No parent" }, ...parents.map((p) => ({ value: String(p.id), label: String(p.title) }))] };
  }
  async function proposalData(action: ProposalData["action"], input: unknown, projectId: string): Promise<ProposalData> {
    if (action === "create_project") {
      const changes = projectFields.parse(input), id = crypto.randomUUID();
      return { action, targetId: id, targetLabel: changes.name, targetRevision: 0, projectId: id, projectRevision: 0, changes, before: {}, schema: schemaJSON(projectFields) };
    }
    const p = await project(projectId);
    let target: RecordRow = p, changes: RecordRow;
    let schema: z.ZodType = projectPatch;
    if (action === "amend_project") changes = projectPatch.parse(input);
    else if (action === "create_issue") {
      changes = issueCreate.parse(input);
      target = { id: crypto.randomUUID(), revision: 0 };
      schema = issueCreate;
    } else {
      const value = actionInputs.amend_issue.parse(input);
      target = await row("planning_issues", value.targetId);
      if (target.projectId !== p.id) throw new Response("Wrong project", { status: 404 });
      changes = value.changes;
      schema = issuePatch;
    }
    if (!Object.keys(changes).length) throw new Response("No changes proposed", { status: 400 });
    const merged = action === "amend_project"
      ? fields(projectFields, { ...target, ...changes })
      : fields(issueFields, { ...target, ...changes, projectId });
    const parentRevision = await parentRevisionFor(merged, projectId, target.id, target.assigneeId);
    const before = action === "amend_project"
      ? fields(projectFields, target)
      : action === "amend_issue" ? fields(issueFields.omit({ projectId: true }), target) : {};
    return {
      action, targetId: String(target.id), targetLabel: proposalLabel(action, target, changes, p), targetRevision: Number(target.revision),
      projectId, projectRevision: Number(p.revision), parentRevision, changes, before, schema: schemaJSON(schema),
      fieldOptions: await proposalOptions(action, projectId, target.id),
    };
  }
  /**
   * Prepare a proposal for one tool call. The request key names the exact call
   * (thread, submission, tool call), so a re-dispatched call returns the same
   * proposal instead of a duplicate; reusing it with other input is a conflict.
   */
  async function propose(input: { threadId: string; submissionId: string; callId: string; focusProjectId: string | null; action: ActionName; value: unknown }) {
    let targetProject = input.focusProjectId, value = input.value, operation: ProposalData["action"];
    if (input.action === "create_project_issue") {
      const parsed = issueFields.parse(input.value);
      targetProject = parsed.projectId;
      const { projectId: _, ...changes } = parsed;
      value = changes;
      operation = "create_issue";
    } else operation = input.action;
    if (operation !== "create_project" && !targetProject) throw new Response("Choose a project", { status: 400 });
    const requestKey = `${input.threadId}:${input.submissionId}:${input.callId}`;
    const identityPayload = { name: input.action, input: input.value };
    // An exact replay must not recompute (and re-randomize) the proposal.
    const existing = (await query("SELECT * FROM planning_proposals WHERE installationId=? AND requestKey=?", [identity.installationId, requestKey]))[0];
    const data = existing ? JSON.parse(String(existing.data)) : await proposalData(operation, value, targetProject ?? "");
    return view(await store.create({
      threadId: input.threadId, turnId: input.submissionId, requestKey, action: operation,
      projectId: data.action === "create_project" ? null : data.projectId, data, identity: identityPayload,
    }));
  }
  async function assertCurrentProposal(data: ProposalData) {
    if (data.action === "create_project") return;
    const p = await project(data.projectId);
    if (data.action === "amend_project" && Number(p.revision) !== data.projectRevision)
      throw new Response("Project changed; create a new proposal", { status: 409 });
    if (data.action === "create_issue") return;
    const target = await row(data.action === "amend_project" ? "planning_projects" : "planning_issues", data.targetId);
    if (Number(target.revision) !== data.targetRevision) throw new Response("Target changed; create a new proposal", { status: 409 });
  }
  function revisionInput(data: ProposalData, changes: unknown) {
    const revised = ["create_issue", "create_project"].includes(data.action)
      ? { ...data.changes, ...(data.action === "create_project" ? projectPatch : issuePatch).parse(changes) }
      : changes;
    return data.action === "amend_issue" ? { targetId: data.targetId, changes: revised } : revised;
  }
  async function revise(id: string, revision: number, changes: unknown) {
    const saved = await store.get(id), old = JSON.parse(saved.data) as ProposalData;
    if (saved.status !== "pending") throw new Response("Proposal is no longer pending", { status: 409 });
    await assertCurrentProposal(old);
    const data = await proposalData(old.action, revisionInput(old, changes), old.projectId);
    if (["create_issue", "create_project"].includes(old.action)) data.targetId = old.targetId;
    if (old.action === "create_project") data.projectId = old.projectId;
    return view(await store.revise(id, revision, data));
  }
  function updateStatement(data: ProposalData, values: RecordRow, table: "planning_projects" | "planning_issues", now: number): Statement {
    const entries = Object.entries(values);
    const position = data.action === "amend_issue"
      ? ",position=CASE WHEN category=? THEN position ELSE (SELECT COALESCE(MAX(x.position),-1)+1 FROM planning_issues x WHERE x.installationId=? AND x.projectId=? AND x.category=?) END"
      : "";
    const category = (values as z.infer<typeof issueFields>).category;
    const positionParams = data.action === "amend_issue" ? [category, identity.installationId, data.projectId, category] : [];
    return {
      sql: `UPDATE ${table} SET ${entries.map(([key]) => `"${key}"=?`).join(",")}${position},revision=revision+1,updatedBy=?,updatedAt=? WHERE id=? AND installationId=? AND revision=?`,
      params: [...entries.map(([, value]) => value), ...positionParams, identity.userId, now, data.targetId, identity.installationId, data.targetRevision],
    };
  }
  function projectApprovalGuard(data: ProposalData): Statement {
    const revision = data.action === "amend_project";
    return store.guard(
      `EXISTS(SELECT 1 FROM planning_projects WHERE id=? AND installationId=?${revision ? " AND revision=?" : ""})`,
      revision ? [data.projectId, identity.installationId, data.projectRevision] : [data.projectId, identity.installationId],
    );
  }
  function approvalSteps(data: ProposalData, fresh: ProposalData): Statement[] {
    const now = Date.now();
    if (data.action === "create_project") {
      const v = projectFields.parse(data.changes), keys = Object.keys(v);
      return [{
        sql: `INSERT INTO planning_projects(id,installationId,${keys.map((k) => `"${k}"`).join(",")},revision,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,${keys.map(() => "?").join(",")},1,?,?,?,?)`,
        params: [data.targetId, identity.installationId, ...Object.values(v), identity.userId, identity.userId, now, now],
      }];
    }
    const steps: Statement[] = [projectApprovalGuard(data)];
    const table = data.action === "amend_project" ? "planning_projects" : "planning_issues";
    if (data.action === "amend_issue")
      steps.push(store.guard(`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND installationId=? AND revision=?)`, [data.targetId, identity.installationId, data.targetRevision]));
    const values = data.action === "amend_project"
      ? projectFields.parse({ ...fresh.before, ...data.changes })
      : issueFields.parse({ ...fresh.before, ...data.changes, projectId: data.projectId });
    if ("parentId" in values && values.parentId)
      steps.push(store.guard(
        "EXISTS(SELECT 1 FROM planning_issues WHERE id=? AND installationId=? AND projectId=? AND revision=?)",
        [values.parentId, identity.installationId, data.projectId, data.parentRevision],
      ));
    if (data.action === "create_issue") {
      const v = values as z.infer<typeof issueFields>;
      steps.push({
        sql: "INSERT INTO planning_issues(id,installationId,projectId,title,description,category,status,assigneeId,dueDate,parentId,position,revision,createdBy,updatedBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM planning_issues WHERE installationId=? AND projectId=? AND category=?),1,?,?,?,?)",
        params: [data.targetId, identity.installationId, data.projectId, v.title, v.description, v.category, v.status, v.assigneeId, v.dueDate, v.parentId,
          identity.installationId, data.projectId, v.category, identity.userId, identity.userId, now, now],
      });
    } else steps.push(updateStatement(data, values, table, now));
    return steps;
  }
  /**
   * Record a committed decision on its conversation timeline. The entry is keyed
   * by the proposal and its payload derives only from the stored row, so a retry
   * after a lost response or failed sync returns the same entry and never repeats
   * the domain write. A failure leaves the receipt unsynced for the next attempt.
   */
  async function syncTimeline(saved: ProposalRow) {
    if (saved.timelineEntryId || saved.status === "pending" || saved.status === "cancelled") return Boolean(saved.timelineEntryId);
    if (!host || saved.threadId.startsWith("legacy:")) return false;
    try {
      const entry = await host.call("threads.append", {
        threadId: saved.threadId,
        sourceKey: `planning.proposal:${saved.id}:decision`,
        role: "event",
        parts: [proposalPart(identity.installationId, saved)],
      });
      await store.markSynced(saved.id, entry.id);
      return true;
    } catch (error) {
      // The thread was deleted: nothing to record; the receipt itself remains.
      if (error instanceof Response && error.status === 404) {
        await store.markSynced(saved.id, "thread-deleted");
        return false;
      }
      return false;
    }
  }
  /** Retry decisions whose timeline entry is still missing (bounded). */
  async function syncPending(threadId?: string) {
    for (const saved of await store.unsynced(threadId)) await syncTimeline(saved);
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: approval reads, revalidates and writes one guarded atomic batch; splitting it would separate the guards from their write.
  async function decide(id: string, revision: number, decision: "approve" | "reject") {
    const saved = await store.get(id), data = JSON.parse(saved.data) as ProposalData;
    const status = decision === "approve" ? "applied" : "rejected";
    // Exact duplicate (e.g. a retry after a lost response): the committed receipt, no second write.
    const replay = store.replay(saved, revision, status);
    if (replay) {
      await syncTimeline(replay);
      const current = await store.get(id);
      return { proposal: view(current), receipt: JSON.parse(String(current.receipt)) };
    }
    if (data.action !== "create_project") await project(data.projectId);
    if (decision === "approve") {
      // The approver must still be able to read the proposal's conversation, in
      // addition to owning the proposal: a vanished thread never yields a write,
      // and reading a shared transcript never grants approval of another's proposal.
      if (!host) throw new Response("Thread host unavailable", { status: 503 });
      if (!(await host.call("threads.get", { ref: { id: saved.threadId } })))
        throw new Response("This proposal's conversation is no longer available", { status: 409 });
    }
    let decided: ProposalRow;
    if (decision === "reject") decided = await store.decide(id, revision, [], { rejected: true }, "rejected");
    else {
      // Revalidate schema, relationships and live membership, but keep the approved target/revisions.
      const fresh = await proposalData(data.action, data.action === "amend_issue" ? { targetId: data.targetId, changes: data.changes } : data.changes, data.projectId);
      decided = await store.decide(id, revision, approvalSteps(data, fresh), { id: data.targetId, revision: data.targetRevision + 1, action: data.action });
    }
    await syncTimeline(decided);
    const current = await store.get(id);
    return { proposal: view(current), receipt: JSON.parse(String(current.receipt)) };
  }
  async function forThread(threadId: string) {
    await syncPending(threadId);
    return (await store.forThread(threadId)).map(view);
  }
  return { store, propose, revise, decide, forThread, syncPending, view, get: async (id: string) => view(await store.get(id)) };
}
