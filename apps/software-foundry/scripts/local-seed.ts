import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

type Database = {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
};
type Organization = { sourceId: string; slug: string };
const row = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(160),
  position: z.number().int().nonnegative(),
  repositories: z.array(z.string()),
  milestones: z.array(z.string()),
  revision: z.number().int().positive(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
const snapshot = z.strictObject({
  format: z.literal("outfitter-software-foundry-local-v1"),
  sourceInstallationId: z.uuid(),
  projects: z.array(row).max(100),
});
const pathFor = (directory: string, slug: string) =>
  join(directory, "app-snapshots", slug, "software-foundry.json");
async function plan(directory: string, organization: Organization) {
  const path = pathFor(directory, organization.slug);
  try {
    const parsed = snapshot.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) throw new Error(`${path} is not a supported Software Foundry snapshot: ${z.prettifyError(parsed.error)}`);
    if (new Set(parsed.data.projects.map((project) => project.id)).size !== parsed.data.projects.length)
      throw new Error(`${path} repeats a project ID`);
    return { path, data: parsed.data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function inspectLocalData({ dataDirectory, organizations }: { dataDirectory: string; seed: unknown; organizations: Organization[] }) {
  const installations: Record<string, { source: string; counts: Record<string, number>; notices: string[] }> = {};
  for (const organization of organizations) {
    const planned = await plan(dataDirectory, organization);
    if (planned)
      installations[organization.sourceId] = { source: planned.path, counts: { projects: planned.data.projects.length }, notices: [] };
  }
  return { installations, notices: [] };
}
export async function seedLocalInstallation({ database, dataDirectory, organization }: { database: Database; dataDirectory: string; seed: unknown; organization: Organization }) {
  const planned = await plan(dataDirectory, organization);
  if (!planned) return { source: "package records", counts: { projects: 0 }, notices: [] };
  const columns = ["id", "name", "position", "repositories", "milestones", "revision", "createdBy", "updatedBy", "createdAt", "updatedAt"];
  const statements = planned.data.projects.map((project) =>
    database.prepare(`INSERT INTO foundry_projects (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(
      ...columns.map((column) => {
        const value = project[column as keyof typeof project];
        return Array.isArray(value) ? JSON.stringify(value) : value;
      }),
    ),
  );
  if (statements.length) await database.batch(statements);
  return { source: planned.path, counts: { projects: planned.data.projects.length }, notices: [] };
}
