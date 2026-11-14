import { defineEntity, type EntityProvider, type EntityRef } from "@ai-outfitter/app-sdk/entities";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { and, asc, desc, eq, or, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { priorityOrder, projects, issues, type Project, type Issue } from "./schema";
import { projectFields, issueFields } from "./fields";
import { createProject, updateProject, createIssue, updateIssue, type PlanningDatabase } from "./planning";

export const projectSearchQuery = z.string().trim().max(256).default("").describe("Case-insensitive literal substring across project name, goals, user stories, repository, press release and demo data. An empty query returns all projects. No query syntax or wildcards.");
const projectFilter = z.strictObject({ name: z.string().trim().min(1).max(160).optional(), query: projectSearchQuery.optional() });

export function projectSearch(query?: string) {
  if (!query) return undefined;
  // Bound values, not SQL fragments. instr treats %, _ and quotes literally.
  return or(...[projects.id, projects.name, projects.githubRepository, projects.goals, projects.userStories, projects.pressRelease, projects.demoInstructions, projects.demoResults]
    .map(column => sql`instr(lower(${column}), lower(${query})) > 0`));
}
const issueFilter = z.strictObject({ projectId: z.uuid().optional(), status: z.enum(["todo", "in-progress", "done"]).optional(), category: z.enum(["stone", "pebble", "sand"]).optional() });

function issueOrder(order?: { field: string; direction: "asc" | "desc" }) {
  const columns: Record<string, AnyColumn> = { id: issues.id, title: issues.title, position: issues.position };
  const column = columns[order?.field ?? "id"] ?? issues.id;
  return order?.direction === "desc" ? desc(column) : asc(column);
}

export function planningEntities(db: PlanningDatabase, memberIds: () => string[] = () => []): EntityProvider[] {
  const project = async (who: AppIdentity, id: string) => {
    const [row] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.installationId, who.installationId)));
    if (!row) throw new Response("Project not found", { status: 404 });
    return row;
  };
  const issue = async (who: AppIdentity, id: string) => {
    const [row] = await db.select().from(issues).where(and(eq(issues.id, id), eq(issues.installationId, who.installationId)));
    if (!row) throw new Response("Issue not found", { status: 404 });
    return row;
  };
  const checkIssueReference = (who: AppIdentity, projectId: string, refs: EntityRef[]) => {
    if (refs.length !== 1 || refs[0].type !== "project" || refs[0].installationId !== who.installationId || refs[0].id !== projectId)
      throw new Response("Reference the issue's project in this installation", { status: 400 });
  };
  const noReferences = (references: EntityRef[]) => {
    if (references.length) throw new Response("Project references are not supported", { status: 400 });
  };
  const portfolioSchema = z.strictObject({ kind: z.enum(["organizations", "projects"]), items: z.array(z.string()).max(500) });
  const portfolio = async (who: AppIdentity) => {
    if (who.owner.kind !== "user" || who.organizationId) throw new Response("Personal portfolio only", { status: 403 });
    const rows = await db.select().from(priorityOrder).where(eq(priorityOrder.installationId, who.installationId));
    return rows.filter(row => ["portfolio-organizations", "portfolio-projects"].includes(row.kind)).map(row => ({
      id: row.kind.slice("portfolio-".length), revision: row.revision,
      kind: row.kind.slice("portfolio-".length) as "organizations" | "projects", items: z.array(z.string()).parse(JSON.parse(row.items)),
    }));
  };
  return [defineEntity<{ id: string; revision: number } & z.infer<typeof portfolioSchema>, typeof portfolioSchema>({
    type: "portfolio-priority", collection: "portfolio-priorities", title: "Personal portfolio priority",
    description: "Read-only saved personal organization or project ordering. References do not grant access; resolve them against current authorized records. Change through ReorderPersonalPortfolio.",
    schema: portfolioSchema, name: row => row.kind,
    // Entity catalog enumeration is shared with organization projects. A
    // personal-only collection is empty there, while direct reads still refuse.
    list: async (who, offset, limit) => who.owner.kind === "user" && !who.organizationId ? (await portfolio(who)).slice(offset, offset + limit) : [],
    get: async (who, id) => { const row = (await portfolio(who)).find(row => row.id === id); if (!row) throw new Response("Priority not saved", { status: 404 }); return row; },
  }), defineEntity<Project, typeof projectFields, typeof projectFilter>({
    type: "project", title: "Planning project", description: "The canonical project record: goals, user stories, repository and acceptance documents. Wiki pages reference this record.",
    schema: projectFields, collection: "projects", filterSchema: projectFilter,
    orderFields: ["id", "name"], selectFields: ["id", ...Object.keys(projectFields.shape)], name: row => row.name,
    list: (who, offset, limit, filter, order) => db.select().from(projects).where(and(eq(projects.installationId, who.installationId),eq(projects.archived,false), filter?.name === undefined ? undefined : eq(projects.name, filter.name), projectSearch(filter?.query))).orderBy(order?.field === "name" ? (order.direction === "desc" ? desc(projects.name) : asc(projects.name)) : order?.direction === "desc" ? desc(projects.id) : asc(projects.id), asc(projects.id)).offset(offset).limit(limit),
    get: project,
    create: (who, fields, references) => {
      noReferences(references);
      return createProject(db, who, fields);
    },
    update: (who, current, fields, revision, references) => {
      noReferences(references);
      return updateProject(db, who, current.id, { ...fields, revision });
    },
  }), defineEntity<Issue, typeof issueFields, typeof issueFilter>({
    type: "issue", title: "Planning issue", description: "Work in a Planning project. Include its project reference. Assignments require a current member of the owning organization.",
    schema: issueFields, collection: "issues", filterSchema: issueFilter,
    orderFields: ["id", "title", "position"], selectFields: ["id", "position", ...Object.keys(issueFields.shape)], name: row => row.title,
    outputAttributes: row => ({ position: row.position }),
    references: (row, who) => [{ installationId: who.installationId, type: "project", id: row.projectId }],
    list: (who, offset, limit, filter, order) => db.select().from(issues).where(and(eq(issues.installationId, who.installationId), filter?.projectId === undefined ? undefined : eq(issues.projectId, filter.projectId), filter?.status === undefined ? undefined : eq(issues.status, filter.status), filter?.category === undefined ? undefined : eq(issues.category, filter.category))).orderBy(issueOrder(order), asc(issues.id)).offset(offset).limit(limit),
    get: issue,
    create: async (who, input, refs) => {
      checkIssueReference(who, input.projectId, refs);
      await project(who, input.projectId);
      return createIssue(db, who, input, input.assigneeId ? memberIds() : []);
    },
    update: async (who, current, input, revision, refs) => {
      checkIssueReference(who, input.projectId, refs);
      await project(who, input.projectId);
      return updateIssue(db, who, current.id, { ...input, revision }, input.assigneeId ? memberIds() : []);
    },
  })];
}

/** Domain callers select providers by type; catalog order can grow independently. */
export function planningEntity(db: PlanningDatabase, type: "project" | "issue") {
  return planningEntities(db).find(provider => provider.type === type)!;
}
