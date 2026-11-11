import { and, asc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { projects, issues } from "./schema";
// biome-ignore lint/suspicious/noExplicitAny: shared D1/libSQL query interface.
export type PlanningDatabase = BaseSQLiteDatabase<"async", any>;
import { projectFields, projectMaskFields, issueFields } from "./fields";
import { requirementList, retireList } from "./requirements";
import { projectNodeSlug, repositoryPatch } from "./repository-patch";
export const revisionField = z.number().int().positive();
const changed = () =>
  new Response(
    "This record changed. Your draft is preserved; reload before retrying.",
    { status: 409 },
  );
const formerMember = () =>
  new Response("Choose a current organization member", { status: 400 });
/** Share assignment policy between manual writes and reviewed agent proposals. */
export function validateAssignee(assigneeId: string | null | undefined, memberIds: readonly string[] | undefined, previous?: unknown) {
  if(!assigneeId || assigneeId===previous)return;
  if(!memberIds)throw new Response("Organization directory unavailable. Retry before assigning work.",{status:503});
  if(!memberIds.includes(assigneeId))throw formerMember();
}
const nextPosition = (installationId: string, projectId: string, category: string) =>
  sql`(SELECT COALESCE(MAX(x.position),-1)+1 FROM planning_issues x WHERE x.installationId=${installationId} AND x.projectId=${projectId} AND x.category=${category})`;
function translate(error: unknown): never {
  for (let e = error; e instanceof Error; e = e.cause)
    if (/constraint|planning_/i.test(e.message))
      throw new Response(
        "Cannot save: check the project, parent, child relationships or record limit.",
        { status: 409 },
      );
  throw error;
}
export async function listPlanning(
  db: PlanningDatabase,
  identity: AppIdentity,
) {
  const [projectRows, issueRows] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(and(eq(projects.installationId, identity.installationId),eq(projects.archived,false)))
      .orderBy(asc(projects.name)),
    db
      .select()
      .from(issues)
      .where(eq(issues.installationId, identity.installationId))
      .orderBy(asc(issues.position), asc(issues.id)),
  ]);
  return { projects: projectRows, issues: issueRows };
}
export async function createProject(
  db: PlanningDatabase,
  identity: AppIdentity,
  input: unknown,
) {
  const value = projectFields.parse(input),
    now = Date.now();
  return (
    await db
      .insert(projects)
      .values({
        ...value,
        id: crypto.randomUUID(),
        installationId: identity.installationId,
        createdBy: identity.userId,
        updatedBy: identity.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0];
}
export async function updateProject(
  db: PlanningDatabase,
  identity: AppIdentity,
  id: string,
  input: unknown,
) {
  const { revision, ...value } = projectFields.extend({ revision: revisionField }).parse(input);
  const [row] = await db
    .update(projects)
    .set({
      ...value,
      revision: revision + 1,
      updatedBy: identity.userId,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(projects.id, id),
        eq(projects.installationId, identity.installationId),
        eq(projects.revision, revision),
      ),
    )
    .returning();
  if (!row) throw changed();
  return row;
}
/** Accept a Projects record as the base; only its identity and revision select the write. */
export const projectBase = z.record(z.string(),z.unknown()).pipe(z.object({id:z.uuid(),revision:revisionField})).describe("An existing Projects record, including id (UUID) and revision (positive integer). Other fields are ignored; only mask fields are edited.");
/** Mask fields replace those fields; requirements upsert by key and retireRequirements retire by key (docs/plans/project-delivery-flow.md). */
export const patchMask = projectMaskFields.extend({
  repositories: repositoryPatch.optional(),
  projectNode: projectNodeSlug.optional(),
  requirements: requirementList.optional().describe("Requirements to add or revise, each by its stable key. Others stay as they are."),
  retireRequirements: retireList.optional().describe("Keys of requirements that no longer apply."),
}).refine(value => Object.values(value).some(field => field !== undefined), "Provide at least one field to edit");
export const patchProjectInput = z.strictObject({project:projectBase,mask:patchMask});
export const archiveProjectInput = z.strictObject({project:projectBase});
export const projectStateInput = z.strictObject({ project: projectBase, state: z.enum(["draft", "backlog", "active", "completed", "archived"]) });
export async function setProjectState(db: PlanningDatabase, identity: AppIdentity, raw: unknown) {
  const { project, state } = projectStateInput.parse(raw);
  const [row] = await db.update(projects).set({ state, archived: state === "archived", revision: project.revision + 1, updatedBy: identity.userId, updatedAt: Date.now() })
    .where(and(eq(projects.id, project.id), eq(projects.installationId, identity.installationId), eq(projects.revision, project.revision))).returning();
  if (!row) throw changed();
  return row;
}
export async function patchProject(db:PlanningDatabase, identity:AppIdentity, raw:unknown) {
  const {project,mask}=patchProjectInput.parse(raw);
  if (mask.repositories !== undefined || mask.projectNode !== undefined || mask.requirements !== undefined || mask.retireRequirements !== undefined)
    throw new Response("Use the PatchProject GraphQL document for repository, Onto node and requirement changes", { status: 400 });
  const [row]=await db.update(projects).set({...mask,revision:project.revision+1,updatedBy:identity.userId,updatedAt:Date.now()})
    .where(and(eq(projects.id,project.id),eq(projects.installationId,identity.installationId),eq(projects.revision,project.revision),eq(projects.archived,false))).returning();
  if(!row)throw changed();
  return row;
}
export async function archiveProject(db:PlanningDatabase, identity:AppIdentity, raw:unknown) {
  const {project}=archiveProjectInput.parse(raw);
  const [row]=await db.update(projects).set({archived:true,state:"archived",revision:project.revision+1,updatedBy:identity.userId,updatedAt:Date.now()})
    .where(and(eq(projects.id,project.id),eq(projects.installationId,identity.installationId),eq(projects.revision,project.revision),eq(projects.archived,false))).returning();
  if(!row)throw changed();
  return row;
}
export async function deleteProject(
  db: PlanningDatabase,
  identity: AppIdentity,
  id: string,
  input: unknown,
) {
  const value = z.object({ revision: revisionField }).strict().parse(input);
  try {
    const rows = await db
      .delete(projects)
      .where(
        and(
          eq(projects.id, id),
          eq(projects.installationId, identity.installationId),
          eq(projects.revision, value.revision),
        ),
      )
      .returning();
    if (!rows.length) throw changed();
    return { deleted: true };
  } catch (error) {
    translate(error);
  }
}
export async function createIssue(
  db: PlanningDatabase,
  identity: AppIdentity,
  input: unknown,
  memberIds: readonly string[] = [],
) {
  const value = issueFields.parse(input),
    now = Date.now();
  validateAssignee(value.assigneeId,memberIds);
  try {
    return (
      await db
        .insert(issues)
        .values({
          ...value,
          id: crypto.randomUUID(),
          installationId: identity.installationId,
          position: nextPosition(identity.installationId, value.projectId, value.category),
          createdBy: identity.userId,
          updatedBy: identity.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0];
  } catch (error) {
    translate(error);
  }
}
export async function updateIssue(
  db: PlanningDatabase,
  identity: AppIdentity,
  id: string,
  input: unknown,
  memberIds: readonly string[] = [],
) {
  const { revision, ...value } = issueFields.extend({ revision: revisionField }).parse(input);
  // A departed member may stay assigned only if the stored value is unchanged.
  const retained =
    value.assigneeId && !memberIds.includes(value.assigneeId)
      ? value.assigneeId
      : null;
  const current = and(
    eq(issues.id, id),
    eq(issues.installationId, identity.installationId),
    eq(issues.revision, revision),
  );
  try {
    const [row] = await db
      .update(issues)
      .set({
        ...value,
        // Moving to another project or category appends to the destination list.
        position: sql`CASE WHEN planning_issues.projectId=${value.projectId} AND planning_issues.category=${value.category} THEN planning_issues.position ELSE ${nextPosition(identity.installationId, value.projectId, value.category)} END`,
        revision: revision + 1,
        updatedBy: identity.userId,
        updatedAt: Date.now(),
      })
      .where(retained ? and(current, eq(issues.assigneeId, retained)) : current)
      .returning();
    if (!row) {
      if (retained && (await db.select({ id: issues.id }).from(issues).where(current)).length)
        throw formerMember();
      throw changed();
    }
    return row;
  } catch (error) {
    translate(error);
  }
}
export async function deleteIssue(
  db: PlanningDatabase,
  identity: AppIdentity,
  id: string,
  input: unknown,
) {
  const value = z.object({ revision: revisionField }).strict().parse(input);
  try {
    const rows = await db
      .delete(issues)
      .where(
        and(
          eq(issues.id, id),
          eq(issues.installationId, identity.installationId),
          eq(issues.revision, value.revision),
        ),
      )
      .returning();
    if (!rows.length) throw changed();
    return { deleted: true };
  } catch (error) {
    translate(error);
  }
}
/** A category's issues in their new order, every one at its current revision. */
export const reorderInput = z
  .object({
    projectId: z.uuid(),
    category: issueFields.shape.category,
    items: z
      .array(
        z
          .object({ id: z.uuid(), revision: revisionField })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export async function reorderIssues(
  db: PlanningDatabase,
  identity: AppIdentity,
  input: unknown,
) {
  const value = reorderInput.parse(input);
  if (new Set(value.items.map((i) => i.id)).size !== value.items.length)
    throw changed();
  const payload = JSON.stringify(value.items);
  const result = await db.all<{ id: string }>(
    sql`UPDATE planning_issues SET position=(SELECT CAST(key AS INTEGER) FROM json_each(${payload}) j WHERE json_extract(j.value,'$.id')=planning_issues.id), revision=revision+1,updatedBy=${identity.userId},updatedAt=${Date.now()} WHERE installationId=${identity.installationId} AND projectId=${value.projectId} AND category=${value.category} AND (SELECT COUNT(*) FROM planning_issues WHERE installationId=${identity.installationId} AND projectId=${value.projectId} AND category=${value.category})=${value.items.length} AND (SELECT COUNT(*) FROM planning_issues x JOIN json_each(${payload}) j ON json_extract(j.value,'$.id')=x.id AND json_extract(j.value,'$.revision')=x.revision WHERE x.installationId=${identity.installationId} AND x.projectId=${value.projectId} AND x.category=${value.category})=${value.items.length} RETURNING id`,
  );
  if (result.length !== value.items.length) throw changed();
  return { reordered: true };
}
