import {
  defineHomeCard,
  type HomeCardNode,
  type HomeCardSize,
} from "@ai-outfitter/app-sdk/home-cards";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import { clip } from "@ai-outfitter/app-sdk/untrusted-text";
import { and, asc, count, eq, ne, sql, type SQL } from "drizzle-orm";
import type { PlanningDatabase } from "./planning";
import { issues, projects } from "./schema";

// Home card for a portal homepage. It
// reads the projects of this Planning installation only, as every member
// already can on the Planning page, with issue counts from Planning's own records.

export const projectCounts: Record<HomeCardSize, number> = {
  small: 1,
  medium: 3,
  large: 6,
};

const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

// Correlated counts use the (installationId, projectId, …) issue index. Outer
// columns are named in full: Drizzle renders `${projects.id}` unqualified.
const issuesWhere = (status: SQL) =>
  sql<number>`(SELECT COUNT(*) FROM planning_issues i WHERE i.installationId=planning_projects.installationId AND i.projectId=planning_projects.id AND ${status})`.mapWith(
    Number,
  );
const openIssues = issuesWhere(sql`i.status<>'done'`);
const completedIssues = issuesWhere(sql`i.status='done'`);

/** Projects in the Planning page's order with their open and completed issue
 * counts; bounded by `limit`, plus installation totals. */
export async function projectSummaries(
  db: PlanningDatabase,
  who: AppIdentity,
  limit: number,
  size: HomeCardSize,
) {
  const openIssuesTotal =
    size === "large"
      ? db
          .select({ issues: count() })
          .from(issues)
          .where(
            and(
              eq(issues.installationId, who.installationId),
              ne(issues.status, "done"),
            ),
          )
      : Promise.resolve([{ issues: 0 }]);
  const [rows, [totals], [open]] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        open: openIssues,
        completed: completedIssues,
      })
      .from(projects)
      .where(eq(projects.installationId, who.installationId))
      .orderBy(asc(projects.name), asc(projects.id))
      .limit(limit),
    db
      .select({ projects: count() })
      .from(projects)
      .where(eq(projects.installationId, who.installationId)),
    openIssuesTotal,
  ]);
  return { rows, projects: totals.projects, openIssues: open.issues };
}

const tally = (open: number, completed: number) =>
  open || completed ? `${open} open · ${completed} completed` : "No issues yet";

export async function readProjects(
  db: PlanningDatabase,
  who: AppIdentity,
  size: HomeCardSize,
): Promise<HomeCardNode[]> {
  const summary = await projectSummaries(db, who, projectCounts[size], size);
  if (!summary.rows.length)
    return [
      {
        kind: "empty",
        text: "No projects yet. Projects created in Planning appear here.",
      },
    ];
  const more = summary.projects - summary.rows.length;
  return [
    ...(size === "large"
      ? ([
          { kind: "metric", label: "Projects", value: summary.projects },
          { kind: "metric", label: "Open issues", value: summary.openIssues },
        ] satisfies HomeCardNode[])
      : []),
    {
      kind: "list",
      label: "Projects",
      items: summary.rows.map((row) => ({
        id: row.id,
        title: clip(row.name, 120),
        meta: tally(row.open, row.completed),
        link: { path: projectPath(row.id) },
      })),
    },
    ...(more > 0
      ? ([
          {
            kind: "link",
            label: `${more} more ${more === 1 ? "project" : "projects"}`,
            target: { path: "/" },
          },
        ] satisfies HomeCardNode[])
      : []),
  ];
}

export function homeCards(db: () => PlanningDatabase) {
  return [
    defineHomeCard({
      cardId: "projects",
      title: "Projects",
      description:
        "Projects in this Planning installation with their open and completed issue counts.",
      sizes: ["small", "medium", "large"],
      defaultSize: "medium",
      read: async ({ identity, size }) => ({
        body: await readProjects(db(), identity, size),
      }),
    }),
  ];
}
