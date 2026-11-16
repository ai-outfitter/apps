// The orders graph pages take, shared by GraphQL connections and graph.query: a record
// column, ascending or descending, then the ID in the same direction. A keyset cursor
// names its order with the record's (value, ID), so it continues only that order.
import type { Keyset, Order } from "./graph-graphql-source";

/** ID_ASC is the default. */
export const orders = {
  ID_ASC: { field: "id", descending: false }, ID_DESC: { field: "id", descending: true },
  CREATED_AT_ASC: { field: "createdAt", descending: false }, CREATED_AT_DESC: { field: "createdAt", descending: true },
  UPDATED_AT_ASC: { field: "updatedAt", descending: false }, UPDATED_AT_DESC: { field: "updatedAt", descending: true },
  TITLE_ASC: { field: "title", descending: false }, TITLE_DESC: { field: "title", descending: true },
} as const satisfies Record<string, Order>;
export type OrderName = keyof typeof orders;
export const orderNames = Object.keys(orders) as [OrderName, ...OrderName[]];

/** A cursor: URL-safe base64, unpadded, of the text's UTF-8 bytes. */
export function cursorOf(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
/** The text of a cursor, or null when it is not one. */
export function cursorText(cursor: string) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0))); }
  catch { return null; }
}
/** The one cursor every page gives: `[orderBy, value, id]`, the record a page ordered by `orderBy`
 * (a graph order, or one an app's table declares) continues after. */
export const keysetCursor = (orderBy: string, key: Keyset) => cursorOf(JSON.stringify([orderBy, key.value, key.id]));
/** A keyset cursor's order and key, or null when the text is not one. */
export function parseKeyset(text: string): { orderBy: string; key: Keyset } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || typeof parsed[2] !== "string") return null;
  const value = parsed[1];
  if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
  return { orderBy: parsed[0], key: { value, id: parsed[2] } };
}
/** Where a page ordered by `orderBy` resumes: the cursor's record. A text that is no cursor, or a cursor of
 * another order, throws what `refuse` makes of the message. */
export function readKeyset(orderBy: string, cursor: string, refuse: (message: string) => unknown): Keyset {
  const text = cursorText(cursor);
  const keyed = text === null ? null : parseKeyset(text);
  if (!keyed) throw refuse("Invalid cursor");
  if (keyed.orderBy !== orderBy) throw refuse(`This cursor does not continue orderBy ${orderBy}; keep orderBy unchanged when paging`);
  return keyed.key;
}
