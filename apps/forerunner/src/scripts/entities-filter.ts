/** One saved record on the Knowledge graph index, as GET discovery/entities returns it. */
export type Entity = {
  id: string;
  title: string;
  kind: string;
  foundIn: string[];
  links: number;
  addedAt: string;
  status: "pending" | "accepted";
  runId: string;
  wikiSlug: string;
  /** Set while pending: the Wiki batch to review it in. */
  batchId?: string;
};
export type Status = "all" | "pending" | "accepted";

/** The rows a search, a status and a type (null for every type) leave. */
export function filterEntities(entities: Entity[], query: string, status: Status, kind: string | null) {
  const q = query.trim().toLowerCase();
  return entities.filter((entity) => (status === "all" || entity.status === status) && (kind === null || entity.kind === kind) && (!q || entity.title.toLowerCase().includes(q)));
}
