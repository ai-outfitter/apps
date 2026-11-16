/** An in-memory `entities.list` for host stubs: the filters Onto's providers support, applied to records
 * already in memory, returned as the SDK's cursor page. Tests that stub the host use it instead of
 * returning arrays, so code under test sees the same page shape and filtering a real provider gives. */
import { type EntityPage, type EntityRecord, selected } from "@ai-outfitter/app-sdk/entities";
import { foldCase, matchesSearch, searchExpression } from "@ai-outfitter/app-sdk/entity-query";

type Input = { ids?: string[]; filter?: Record<string, unknown>; search?: string; order?: { field: string; direction: "asc" | "desc" }; after?: string; limit?: number; select?: string[] };
const attribute = (record: EntityRecord, key: string) => record.attributes[key];
const among = (value: unknown, list: unknown) => Array.isArray(list) && list.includes(value);

function matches(record: EntityRecord, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, wanted]) => {
    if (wanted === undefined) return true;
    switch (key) {
      case "typeIds": return among(attribute(record, "typeId"), wanted);
      case "names": return among(attribute(record, "name"), wanted);
      case "nodeId": return attribute(record, "fromId") === wanted || attribute(record, "toId") === wanted;
      case "nodeIds": return among(attribute(record, "fromId"), wanted) || among(attribute(record, "toId"), wanted);
      case "titleContains": return foldCase(record.title).includes(foldCase(String(wanted)));
      case "archived": return !!attribute(record, "archived") === wanted;
      case "properties": {
        const properties = (attribute(record, "properties") ?? {}) as Record<string, unknown>;
        return Object.entries(wanted as Record<string, unknown>).every(([name, value]) => properties[name] === value);
      }
      default: return attribute(record, key) === wanted;
    }
  });
}
const text = (record: EntityRecord) => [record.title, ...Object.values(record.attributes).filter(value => typeof value === "string")].join("\n");

export function memoryEntityPage(records: EntityRecord[], input: Input = {}): EntityPage {
  const search = input.search ? searchExpression(input.search) : undefined;
  const order = input.order ?? { field: "id", direction: "asc" as const };
  const key = (record: EntityRecord) => order.field === "id" ? record.ref.id : String(attribute(record, order.field) ?? "");
  const sorted = records
    .filter(record => (!input.ids || input.ids.includes(record.ref.id)) && matches(record, input.filter ?? {}) && (!search || matchesSearch(search, text(record))))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0) * (order.direction === "desc" ? -1 : 1));
  const start = input.after ? Number(atob(input.after)) : 0;
  const limit = input.limit ?? 50;
  const { select } = input;
  const page = sorted.slice(start, start + limit).map(record => select ? selected(record, select) : record);
  const more = sorted.length > start + limit;
  return { records: page, pageInfo: { hasNextPage: more, endCursor: more ? btoa(String(start + limit)) : null } };
}
