// Digest eval cases from two Planning exports of the same installation, taken on
// different days: the older one stands in for the previous digest's snapshot and
// the newer one for "now". Each project in the newer export becomes one case,
// with its changes computed by the production diff (src/server/digests.ts).
import { readFile } from "node:fs/promises";
import { type DigestChanges, diffProject, hasChanges, type Records } from "../../src/server/digests";
import type { Issue, Project } from "../../src/server/schema";

export type PlanningExport = { installationId: string; projects: Project[]; issues: Issue[]; takenAt: number };
export type DigestCase = {
  id: string;
  project: string;
  since: number | null;
  now: number;
  changes: DigestChanges;
  changed: boolean;
  /** Every issue title the project had in either export: anything else the model names is invented. */
  knownTitles: string[];
};

type EntityRecord = { ref: { id: string }; revision: number; attributes: Record<string, unknown> };
const isEntity = (row: unknown): row is EntityRecord => typeof row === "object" && row !== null && "ref" in row && "attributes" in row;
/** A flat row (outfitter-planning-local-v1) or an entity record (the production refresh format). */
function row<T>(value: unknown, installationId: string): T {
  if (!isEntity(value)) return { installationId, ...(value as object) } as T;
  return { installationId, ...value.attributes, id: value.ref.id, revision: value.revision } as T;
}
const latest = (rows: { createdAt?: number; updatedAt?: number }[]) => Math.max(0, ...rows.map((item) => item.updatedAt ?? item.createdAt ?? 0));

/** Read either export format. `takenAt` defaults to the newest record timestamp. */
export function parseExport(value: unknown, takenAt?: number): PlanningExport {
  const data = value as { sourceInstallationId?: string; source?: { installationId?: string }; projects?: unknown[]; issues?: unknown[] };
  if (!Array.isArray(data.projects) || !Array.isArray(data.issues)) throw new Error("Not a Planning export: projects and issues are required");
  const installationId = data.sourceInstallationId ?? data.source?.installationId ?? "unknown";
  const projectDefaults = { archived: false, githubRepository: "", goals: "", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "" };
  const projects = data.projects.map((item) => ({ ...projectDefaults, ...row<Project>(item, installationId) }));
  const issueDefaults = { description: "", status: "todo", assigneeId: null, dueDate: null, parentId: null, position: 0 };
  const issues = data.issues.map((item) => ({ ...issueDefaults, ...row<Issue>(item, installationId) }));
  return { installationId, projects, issues, takenAt: takenAt ?? latest([...projects, ...issues]) };
}

export const readExport = async (path: string, takenAt?: number) => parseExport(JSON.parse(await readFile(path, "utf8")), takenAt);

const records = (data: PlanningExport, project: Project): Records => ({
  project,
  issues: data.issues.filter((issue) => issue.projectId === project.id),
  submissions: [],
});

/** The previous digest's snapshot: the project in `older`, or an empty one when it was created since. */
async function previousSnapshot(older: PlanningExport, project: Project, before: Project | undefined) {
  const blank = { ...project, goals: "", userStories: "", pressRelease: "", demoInstructions: "", demoResults: "" };
  const base: Records = before ? records(older, before) : { project: blank, issues: [], submissions: [] };
  return (await diffProject(base, null, older.takenAt)).snapshot;
}

async function caseFor(older: PlanningExport | null, newer: PlanningExport, project: Project): Promise<DigestCase> {
  const before = older?.projects.find((item) => item.id === project.id);
  const previous = older ? await previousSnapshot(older, project, before) : null;
  const { changes } = await diffProject(records(newer, project), previous, newer.takenAt);
  const earlier = older && before ? records(older, before).issues : [];
  const titles = new Set([...records(newer, project).issues, ...earlier].map((issue) => issue.title));
  return {
    id: project.id,
    project: project.name,
    since: older ? older.takenAt : null,
    now: newer.takenAt,
    changes,
    changed: hasChanges(changes),
    knownTitles: [...titles],
  };
}

/** One case per project in `newer`, diffed against `older`. Without `older`, each case is a first digest (the last 24 hours). */
export async function buildCases(older: PlanningExport | null, newer: PlanningExport): Promise<DigestCase[]> {
  if (older && older.installationId !== newer.installationId)
    throw new Error("Both exports must come from the same installation");
  const cases: DigestCase[] = [];
  for (const project of newer.projects.filter((item) => !item.archived)) cases.push(await caseFor(older, newer, project));
  return cases;
}
