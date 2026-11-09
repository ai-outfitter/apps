// Client-safe: the projects page script and its server render build the same cards.
// biome-ignore-all lint/style/noNonNullAssertion: none
import { projectRows } from "./project-rows";

export type CardProject = {
  id: string; name: string; rank?: number | null; href?: string; openIssues?: number; organizationSlug?: string | null;
  readiness?: { stage: string; priority: number; missing: string[]; signals: string[] };
  goalRecords?: { id: string; title: string }[];
};
export type CardGoal = { id: string; title: string; summary: string; metrics: { id: string; title: string }[] };
/** A project's light: ready to implement, decisions needed, or not assessed. */
export type Light = "green" | "yellow" | "none";

export const lightOf = (project: CardProject): Light =>
  !project.readiness ? "none" : project.readiness.stage === "implement" && !project.readiness.missing.length ? "green" : "yellow";
export const lightLabel: Record<Light, string> = { green: "Ready", yellow: "Decisions needed", none: "Not assessed" };
/** The status pill's text: ready, the count of decisions still needed, or the stage reached. */
export const statusLabel = (project: CardProject): string => {
  const light = lightOf(project);
  if (light !== "yellow" || !project.readiness) return lightLabel[light];
  const missing = project.readiness.missing.length;
  return missing ? `${missing} decision${missing === 1 ? "" : "s"}` : project.readiness.stage;
};

/** How many projects a card shows before "more". */
export const CARD_PROJECTS = 3;
/** Stable default order until an organization assigns an explicit rank. */
export const rankProjects = <T extends CardProject>(projects: T[]): T[] =>
  [...projects].sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

/** Projects by light, for one goal's bar: green, yellow, then unassessed. */
export type GoalProgress = { goal: CardGoal; green: number; yellow: number; none: number; total: number };

export type OrganizationCard<T extends CardProject = CardProject> = {
  key: string;
  label: string;
  projects: T[];
  /** The organization's goals with the projects that pursue each, by light. */
  goals: GoalProgress[];
  /** Projects that pursue none of the organization's goals. */
  unlinked: number;
};

/** One card per organization (the member's own projects first), each goal with its projects' lights. */
export function organizationCards<T extends CardProject>(projects: T[], goals: Record<string, { goals: CardGoal[] } | undefined>): OrganizationCard<T>[] {
  return projectRows(projects).map((row) => {
    const own = goals[row.key]?.goals ?? [];
    const progress = own.map((goal) => {
      const pursuing = row.projects.filter((project) => project.goalRecords?.some((record) => record.id === goal.id));
      const count = (light: Light) => pursuing.filter((project) => lightOf(project) === light).length;
      return { goal, green: count("green"), yellow: count("yellow"), none: count("none"), total: pursuing.length };
    });
    const linked = new Set(own.map((goal) => goal.id));
    return {
      key: row.key, label: row.label, projects: rankProjects(row.projects), goals: progress,
      unlinked: row.projects.filter((project) => !project.goalRecords?.some((record) => linked.has(record.id))).length,
    };
  });
}
