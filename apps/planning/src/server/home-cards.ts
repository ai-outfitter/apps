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
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { readDailyReport } from "./digest-wiki";
import { configuredReportPeriod } from "./report-config";
import { personalPortfolio } from "./personal-portfolio";

// Organization Home reads its own Planning records and issue counts.
// Personal Home reads the authorized portfolio in the member's saved order.

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

/** Personal Home uses the same authorized portfolio and saved order as Planning. */
export async function readPersonalProjects(
  db: () => PlanningDatabase,
  host: () => WorkflowHost<"interactive">,
  identity: AppIdentity,
  size: HomeCardSize,
): Promise<HomeCardNode[]> {
  try {
    const portfolio = await personalPortfolio({ db, host, identity }, "projects");
    const shown = portfolio.records.slice(0, projectCounts[size]);
    if (!shown.length) return [{ kind: "empty", text: "No projects yet. Projects created in Planning appear here." }];
    return [
      ...(size === "large" ? [{ kind: "metric" as const, label: "Projects", value: portfolio.records.length }] : []),
      { kind: "list", label: "Your portfolio", items: shown.map(record => {
        const separator = record.id.indexOf(":");
        const scope = record.id.slice(0, separator);
        return { id: record.id, title: clip(record.name, 120), subtitle: scope === "personal" ? "Personal" : scope };
      }) },
      { kind: "link", label: portfolio.records.length > shown.length ? `${portfolio.records.length - shown.length} more in your portfolio` : "Open your portfolio", target: { path: "/projects" } },
    ];
  } catch {
    return [{ kind: "notice", tone: "warning", text: "Your portfolio could not be read. Open Planning to retry." }];
  }
}

/** Read persisted notes only: opening home never starts generation or connector calls. */
export async function dailySummaryNodes(host: () => WorkflowHost<"interactive">, identity: AppIdentity, now=Date.now()): Promise<HomeCardNode[]> {
  try {
    const client=host();
    const period=await configuredReportPeriod(client,now);
    const report=await readDailyReport(client,identity,{date:period.date,timezone:period.timezone});
    if(!report)return [{kind:"notice",tone:"info",text:`The daily report for ${period.date} is not available yet.`}];
    const reference=report.reference as {installationId:string;slug:string;revision:number};
    return [
      {kind:"status",label:`${period.date} · ${report.status === "complete" ? "Sources captured" : "Incomplete sources"}`,tone:report.status === "complete" ? "info" : "warning"},
      {kind:"text",text:clip(String(report.summary ?? "Review your daily report and pending decisions."),500)},
      {kind:"link",label:identity.owner.kind === "user" ? "Read your daily overview" : "Read the organization report",target:{installationId:reference.installationId,path:`/p/${encodeURIComponent(reference.slug)}?revision=${reference.revision}`}},
    ];
  } catch {
    return [{kind:"notice",tone:"warning",text:"The daily report could not be read. Its absence does not mean there was no activity."}];
  }
}

export function homeCards(db: () => PlanningDatabase, host?: () => WorkflowHost<"interactive">) {
  return [
    defineHomeCard({
      cardId: "projects",
      title: "Projects",
      description:
        "Organization projects with issue counts, or your authorized personal portfolio in its saved order.",
      sizes: ["small", "medium", "large"],
      defaultSize: "medium",
      read: async ({ identity, size }) => ({
        body: [...(host ? await dailySummaryNodes(host,identity) : []), ...await (host && identity.owner.kind === "user" ? readPersonalProjects(db, host, identity, size) : readProjects(db(), identity, size))],
      }),
    }),
  ];
}
