// The orders graph pages take, shared by GraphQL connections and graph.query: a record
// column, ascending or descending, then the ID in the same direction. A keyset cursor
// names its order with the record's (value, ID), so it continues only that order.
import type { Keyset, Order } from "./graph-graphql-source";

/** ID_ASC is the default, so cursors made before orderBy keep their meaning. */
export const orders = {
  ID_ASC: { field: "id", descending: false }, ID_DESC: { field: "id", descending: true },
  CREATED_AT_ASC: { field: "createdAt", descending: false }, CREATED_AT_DESC: { field: "createdAt", descending: true },
  UPDATED_AT_ASC: { field: "updatedAt", descending: false }, UPDATED_AT_DESC: { field: "updatedAt", descending: true },
  TITLE_ASC: { field: "title", descending: false }, TITLE_DESC: { field: "title", descending: true },
} as const satisfies Record<string, Order>;
export type OrderName = keyof typeof orders;
export const orderNames = Object.keys(orders) as [OrderName, ...OrderName[]];
export const isOrderName = (value: unknown): value is OrderName => typeof value === "string" && Object.hasOwn(orders, value);
/** The name of an order, as orderBy spells it. */
export const orderNameOf = (order: Order) =>
  orderNames.find(name => orders[name].field === order.field && orders[name].descending === order.descending) as OrderName;

/** URL-safe base64 of any text. */
export const cursorOf = (text: string) => btoa(encodeURIComponent(text)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** The text of a cursor, or null when it is not one. */
export function cursorText(cursor: string) {
  try { return decodeURIComponent(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))); } catch { return null; }
}
/** The cursor of a keyset page after `key` in `orderBy`. */
export const keysetCursor = (orderBy: OrderName, key: Keyset) => cursorOf(JSON.stringify([orderBy, key.value, key.id]));
/** A keyset cursor's order and key, or null when the text is not one. */
export function parseKeyset(text: string): { orderBy: OrderName; key: Keyset } | null {
  if (!text.startsWith("[")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !isOrderName(parsed[0]) || typeof parsed[2] !== "string") return null;
  const value = parsed[1];
  if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
  return { orderBy: parsed[0], key: { value, id: parsed[2] } };
}
