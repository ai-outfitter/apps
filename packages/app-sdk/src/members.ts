import { z } from "zod";

/** A bounded live directory snapshot, supplied only by authenticated dispatch. */
export const memberIdsHeader = "x-outfitter-member-ids";
export const memberIds = z.array(z.string().min(1).max(128)).max(500);
export type OrganizationMember = { id: string; name: string };

export function encodeMemberIds(ids: string[]) {
  const encoded = encodeURIComponent(JSON.stringify(memberIds.parse(ids)));
  if (encoded.length > 60_000)
    throw new Response("Organization directory exceeds the supported limit", { status: 503 });
  return encoded;
}

/** App servers never trust browser-supplied membership. The platform replaces
 * this header after checking the approved organization.members.read capability. */
export function requestMemberIds(request: Request): string[] {
  try {
    const encoded = request.headers.get(memberIdsHeader) ?? "";
    if (encoded.length > 60_000) throw new Error("Oversized directory");
    return memberIds.parse(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    throw new Response("Organization directory unavailable", { status: 503 });
  }
}

export async function organizationMembers(fetcher: typeof fetch = fetch): Promise<OrganizationMember[]> {
  const response = await fetcher("/api/platform/members", { credentials: "same-origin" });
  if (!response.ok) throw Object.assign(new Error("Organization directory unavailable. Reload before assigning work."), { status: response.status });
  return (await response.json() as { items: OrganizationMember[] }).items;
}
