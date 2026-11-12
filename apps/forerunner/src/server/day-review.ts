import { appDataContext } from "@ai-outfitter/app-sdk/database";
import { graphGraphqlResult } from "@ai-outfitter/app-sdk/graph-protocol";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { listItems, type Database } from "./items";
import { itemCompletions } from "./schema";
import { localDate, reviewInput, reviewPeriod, shiftDate, type ReviewPeriod } from "./review-period";

type Host = WorkflowHost<"interactive">;
export type ObservedWork = { title: string; kind: "Merged pull request" | "Direct commit" | "Completed issue observation"; url: string };
export type ReportSource = { scope: string; name: string; status: "complete" | "incomplete" | "missing" | "unavailable"; summary: string; href: string | null; work: ObservedWork[]; more: boolean; projects?: { projectId?: string; name: string; update: string }[] };
export type DayReview = {
  period: ReviewPeriod; latestDate: string; previousDate: string; nextDate: string | null; previousWeek: string; nextWeek: string | null;
  completions: { id: string; itemId: string; title: string; category: string; completedAt: number; available: boolean }[];
  organizations: ReportSource[]; overview: ReportSource | null; warnings: string[];
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const source = (scope: string, name: string, status: ReportSource["status"], summary: string): ReportSource => ({ scope, name, status, summary, href: null, work: [], more: false });
function githubUrl(value: unknown) {
  try { const url = new URL(text(value)); return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null; } catch { return null; }
}
function observedWork(report: Record<string, unknown>, period: ReviewPeriod, scope: string) {
  const work = new Map<string, ObservedWork>();
  let more = false;
  for (const dependency of rows(report.dependencies ?? report.personalProjects)) {
    const summary = record(dependency.summary);
    more ||= Number(summary.omittedIssueObservations ?? 0) > 0;
    for (const issue of rows(summary.completedIssues)) {
      const at = Number(issue.observedAt), projectId = text(dependency.projectId);
      if (projectId && at >= period.start && at < period.end) {
        const path = scope === "personal" ? "/apps/planning" : `/o/${encodeURIComponent(scope)}/planning`;
        const url = `${path}/projects/${encodeURIComponent(projectId)}`;
        work.set(`issue:${scope}:${text(issue.id)}`, { title: text(issue.title).slice(0, 300), kind: "Completed issue observation", url });
      }
    }
    const evidence = record(summary.repositoryEvidence);
    more ||= Number(evidence.omittedRepositoryCount ?? 0) > 0;
    for (const repository of rows(evidence.repositories)) {
      more ||= Number(repository.omittedPullRequestCount ?? 0) > 0 || Number(repository.omittedDirectCommitCount ?? 0) > 0;
      for (const pull of rows(repository.pullRequests)) {
        const at = Date.parse(text(pull.mergedAt)), url = githubUrl(pull.url);
        if (url && at >= period.start && at < period.end) work.set(url, { title: `#${pull.number} ${text(pull.title)}`.slice(0, 300), kind: "Merged pull request", url });
      }
      for (const commit of rows(repository.directCommits)) {
        const at = Date.parse(text(commit.committedAt)), url = githubUrl(commit.url);
        if (url && at >= period.start && at < period.end) work.set(url, { title: text(commit.headline).slice(0, 300), kind: "Direct commit", url });
      }
    }
  }
  return { work: [...work.values()].slice(0, 20), more: more || work.size > 20 };
}
/** Saved reports only. Their exact period must match before any observations are shown. */
export function reportSource(raw: unknown, scope: string, name: string, period: ReviewPeriod): ReportSource {
  if (raw === null || raw === undefined) return source(scope, name, "missing", "No daily report was saved for this date.");
  const report = record(raw), captured = record(report.period);
  if (captured.date !== period.date || captured.timezone !== period.timezone || captured.start !== period.start || captured.end !== period.end)
    return source(scope, name, "unavailable", "The saved report does not match this date and time zone.");
  if (report.status !== "complete" && report.status !== "incomplete") return source(scope, name, "unavailable", "The saved report has no valid source status.");
  const reference = record(report.reference), slug = text(reference.slug), revision = Number(reference.revision);
  const path = scope === "personal" ? "/apps/wiki-map" : `/o/${encodeURIComponent(scope)}/wiki-map`;
  const href = slug && Number.isInteger(revision) && revision > 0 ? `${path}/p/${encodeURIComponent(slug)}?revision=${revision}` : null;
  return { ...source(scope, name, report.status, text(report.summary).slice(0, 1200)), href, projects: rows(report.dependencies ?? report.personalProjects).map(child => {
    const summary = record(child.summary);
    return { projectId: text(child.projectId), name: text(summary.name), update: text(summary.summary).replace(/#\d+\s*/g, "") };
  }).filter(project => project.name), ...observedWork(report, period, scope) };
}
const memberships = z.object({ viewer: z.object({ orgs: z.array(z.object({ slug: z.string(), name: z.string().nullable(), appSlugs: z.array(z.string()) })) }) });
const reports = z.object({ viewer: z.object({ orgs: z.array(z.object({ slug: z.string(), dailyReports: z.object({ nodes: z.array(z.object({ report: z.unknown() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }) })) }) });
async function savedOrder(host: Host) {
  try {
    const planning = await appDataContext(host).apps.database("planning");
    const row = await planning.collection("portfolio-priorities").get("organizations");
    return z.array(z.string()).parse(row.attributes.items);
  } catch (error) {
    if (error instanceof Response && [404, 409].includes(error.status)) return [];
    throw error;
  }
}
async function organizationReports(host: Host, period: ReviewPeriod): Promise<{ sources: ReportSource[]; warnings: string[] }> {
  const [current, order] = await Promise.all([
    host.call("platform.document", { document: "Viewer", query: "query { viewer { orgs { slug name appSlugs } } }" }).then(value => memberships.parse(value).viewer.orgs),
    savedOrder(host),
  ]);
  const rank = new Map(order.map((slug, index) => [slug, index]));
  const available = current.filter(org => org.appSlugs.includes("planning")).sort((a, b) => (rank.get(a.slug) ?? order.length) - (rank.get(b.slug) ?? order.length));
  const sources = await Promise.all(available.slice(0, 20).map(async org => {
    const name = org.name ?? org.slug;
    try {
      const result = reports.parse(await host.call("platform.document", {
        document: "Viewer", variables: { slugs: [org.slug], date: period.date, timezone: period.timezone },
        query: "query DayReports($slugs:[String!],$date:String!,$timezone:String){viewer{orgs(slugs:$slugs){slug dailyReports(first:1,date:$date,timezone:$timezone){nodes{report} pageInfo{hasNextPage}}}}}",
      }));
      const connection = result.viewer.orgs.find(row => row.slug === org.slug)?.dailyReports;
      if (!connection || connection.nodes.length !== 1 || connection.pageInfo.hasNextPage) throw new Error("Incomplete report read");
      return reportSource(connection.nodes[0].report, org.slug, name, period);
    } catch { return source(org.slug, name, "unavailable", "This organization's saved report could not be read."); }
  }));
  return { sources, warnings: available.length > 20 ? ["Only the first 20 organizations in your priority order are shown."] : [] };
}
async function ownOverview(host: Host, identity: AppIdentity, period: ReviewPeriod) {
  try {
    const planning = await appDataContext(host).apps.database("planning");
    const result = graphGraphqlResult.parse(await host.call("actions.call", {
      installationId: planning.installationId, action: "graph.graphql", readOnly: true,
      input: { query: "query DailyOverview($input:DailyReportInput!){dailyReport(input:$input)}", variables: { input: { date: period.date, timezone: period.timezone } }, maxBytes: 262144 },
    }));
    if (result.errors?.length || result.extensions?.truncated || !result.data) throw new Error("Incomplete overview read");
    let scope = "personal";
    if (identity.organizationId) {
      const current = memberships.parse(await host.call("platform.document", { document: "Viewer", query: "query { viewer { orgs { slug name appSlugs } } }" })).viewer.orgs;
      if (current.length !== 1) throw new Error("Organization scope is ambiguous");
      scope = current[0].slug;
    }
    return reportSource(result.data.dailyReport, scope, "Daily overview", period);
  } catch { return source("personal", "Daily overview", "unavailable", "Your saved daily overview could not be read."); }
}
export async function readDayReview(db: Database, identity: AppIdentity, host: Host, raw: z.input<typeof reviewInput>, now = Date.now()): Promise<DayReview> {
  const period = reviewPeriod(raw, now), latestDate = shiftDate(localDate(now, period.timezone), -1);
  const [completed, current, overview, organizations] = await Promise.all([
    db.select().from(itemCompletions).where(and(eq(itemCompletions.installationId, identity.installationId), eq(itemCompletions.ownerId, identity.userId), gte(itemCompletions.completedAt, period.start), lt(itemCompletions.completedAt, period.end))).orderBy(asc(itemCompletions.completedAt)).limit(101),
    listItems(db, identity),
    ownOverview(host, identity, period),
    identity.organizationId ? Promise.resolve({ sources: [] as ReportSource[], warnings: [] as string[] }) : organizationReports(host, period).catch(() => ({ sources: [] as ReportSource[], warnings: ["Organization report sources could not be loaded. This is not evidence of no activity."] })),
  ]);
  const existing = new Set(current.map(item => item.id));
  return { period, latestDate, previousDate: shiftDate(period.date, -1), nextDate: period.date < latestDate ? shiftDate(period.date, 1) : null,
    previousWeek: shiftDate(period.date, -7), nextWeek: shiftDate(period.date, 7) <= latestDate ? shiftDate(period.date, 7) : null,
    completions: completed.slice(0, 100).map(row => ({ id: row.id, itemId: row.itemId, title: row.title, category: row.category, completedAt: row.completedAt, available: existing.has(row.itemId) })),
    overview, organizations: identity.organizationId ? [overview] : organizations.sources, warnings: [...organizations.warnings, ...(completed.length > 100 ? ["Only the first 100 board completions are shown for this day."] : [])],
  };
}
