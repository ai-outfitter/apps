import type { Project } from "./project";

/** A project's sections, one page each, in the order the sidebar lists them. */
export const SECTIONS = [
  { id: "overview", label: "Project brief", path: "" },
  { id: "research", label: "Research & sourcing", path: "/research" },
  { id: "design", label: "Design workbench", path: "/design" },
  { id: "parts", label: "Parts & cost", path: "/parts" },
  { id: "bench", label: "Bench & evidence", path: "/bench" },
  { id: "release", label: "Package & handoff", path: "/release" },
  { id: "concepts", label: "Design concepts", path: "/concepts" },
  { id: "assembly", label: "Assembly & inventory", path: "/assembly" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const isSection = (id: string): id is SectionId => SECTIONS.some((s) => s.id === id);

/** A readable slug that ends with the last 12 hex digits of the project's ID,
 * so a rename keeps old links working. */
export function projectSlug(p: Pick<Project, "id" | "name">) {
  const words = p.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const key = p.id.slice(-12);
  return words ? `${words}-${key}` : key;
}

/** The end of the project ID a slug carries. */
export const slugId = (slug: string) => /(?:^|-)([0-9a-f]{12})$/.exec(slug)?.[1];

/** A project section's path, relative to the app's base. */
export function projectPath(slug: string, section: SectionId = "overview") {
  return `/projects/${slug}${SECTIONS.find((s) => s.id === section)?.path ?? ""}`;
}

/** The app's base path from the current address, wherever the app is mounted. */
export const appBase = (pathname: string) => pathname.replace(/\/projects(?:\/.*)?$/, "").replace(/\/$/, "");
