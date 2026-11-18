/** Concise factual rollups from captured child reports, never inferred launch results. */
export function projectRollup(children: { status?: unknown; summary?: unknown }[]): string {
  const highlights = children.slice(0, 4).map(child => {
    const summary = child.summary && typeof child.summary === "object" ? child.summary as Record<string, unknown> : {};
    return `${String(summary.name ?? "Project")}: ${typeof summary.summary === "string" ? summary.summary : "report unavailable"}`;
  });
  if (!children.length) return "No active project reports were captured for this day.";
  const missing = children.filter(child => child.status !== "complete").length;
  return `${highlights.join(" ")}${children.length > 4 ? ` ${children.length - 4} more projects are in the source reports.` : ""}${missing ? ` ${missing} project reports have incomplete evidence.` : ""}`;
}
export function organizationRollup(organizations: Record<string, unknown>[]): string {
  if (!organizations.length) return "No organization reports were available for this day.";
  return organizations.slice(0, 4).map(org => `${String(org.organizationSlug ?? "Organization")}: ${typeof org.summary === "string" ? org.summary : "daily report unavailable"}`).join(" ");
}
