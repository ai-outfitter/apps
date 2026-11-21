import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ResolvedAssembly } from "./assembly-resolution";

const pageBytes = 64 * 1024;
export const pageCursor = /^([a-f0-9]{64}):([1-9][0-9]{0,15})$/;

/** A single item can exceed the GraphQL limit. Page the serialized record so even
 * large CAD plans and motion tracks round-trip without truncating an array. */
export function resolvedPage(record:ResolvedAssembly, cursor?:string) {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = bytesToHex(sha256(bytes));
  const token = cursor === undefined ? undefined : pageCursor.exec(cursor);
  if (cursor !== undefined && !token) throw Error("Invalid assembly page cursor");
  if (token && digest !== token[1]) throw Error("Resolved assembly changed. Restart with no cursor.");
  const offset = token ? Number(token[2]) : 0;
  if (offset >= bytes.length || (bytes[offset] & 0xc0) === 0x80) throw Error("Invalid assembly page offset");
  let end = Math.min(bytes.length, offset + pageBytes);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    projectId:record.projectId, revision:record.revision, sha256:digest,
    offset, totalBytes:bytes.length, jsonText:new TextDecoder().decode(bytes.subarray(offset,end)),
    nextCursor:end < bytes.length ? digest+":"+end : null,
  };
}
