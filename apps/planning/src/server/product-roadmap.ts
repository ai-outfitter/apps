import type { GraphDatabase } from "./graph-database";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";

const active = (r: EntityRecord) => !r.attributes.archived && !r.attributes.archivedAt;
function body(record: EntityRecord): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(record.attributes.body ?? ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function sections(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is { title: string; intent: string; decisions: string[]; open_questions: string[] } => !!s && typeof s.title === "string" && typeof s.intent === "string" && Array.isArray(s.decisions) && s.decisions.every((x: unknown) => typeof x === "string") && Array.isArray(s.open_questions) && s.open_questions.every((x: unknown) => typeof x === "string"));
}

/** Follow the quarterly product control's projected occurrence to its own plan. */
export async function readProductRoadmap(db: GraphDatabase, organizationId: string) {
  async function list(collection: "types" | "nodes", where: Record<string, unknown>) {
    const records: EntityRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await db.collection(collection).list({ where, offset, limit: 100 });
      records.push(...page);
      if (page.length < 100) return records;
      if (records.length >= 10000) throw new Response("Roadmap context exceeds its read bound", { status: 413 });
    }
  }
  const types = await list("types", { archived: false });
  const typeIds = (names: string[]) => types.filter(t => active(t) && names.includes(String(t.attributes.name))).map(t => t.ref.id);
  const controls = (await Promise.all(typeIds(["DecisionControlV3", "DecisionControlV5"]).map(typeId => list("nodes", { typeId, archived: false })))).flat()
    .filter(r => { const b = body(r); return active(r) && b.organization_id === organizationId && b.kind === "product_strategy" && (b.schedule as Record<string, unknown> | undefined)?.kind === "quarterly"; });
  const controlIds = new Set(controls.map(r => r.ref.id));
  const occurrences = (await Promise.all(typeIds(["ControlOccurrence"]).map(typeId => list("nodes", { typeId, archived: false })))).flat()
    .filter(r => { const b = body(r); return active(r) && b.organization_id === organizationId && controlIds.has(String(b.control_id)) && typeof b.document_id === "string"; })
    .sort((a, b) => String(body(b).due_on ?? "").localeCompare(String(body(a).due_on ?? "")) || a.ref.id.localeCompare(b.ref.id));
  const planTypes = new Set(typeIds(["Plan"]));
  for (const occurrence of occurrences) {
    let document: EntityRecord;
    try { document = await db.collection("nodes").get(String(body(occurrence).document_id)); }
    catch (error) { if (error instanceof Response && error.status === 404) continue; throw error; }
    const plan = body(document);
    if (active(document) && planTypes.has(String(document.attributes.typeId)) && plan.kind === "product_roadmap_lifecycle" && plan.organization_id === organizationId) {
      return { id: document.ref.id, title: document.title, status: String(plan.status ?? "draft"), scope: typeof plan.scope === "string" ? plan.scope : "", dueOn: String(body(occurrence).due_on ?? ""), sections: sections(plan.sections) };
    }
  }
  return null;
}
