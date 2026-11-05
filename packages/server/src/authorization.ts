import type { RequestTenant } from "./hosts";

/**
 * Accept only the server-verified authorization result, never raw client
 * claims: the admin claim and the live session row (or fresh facts) must agree.
 */
export function requirePlatformAdmin<T extends {
  tenant: RequestTenant;
  claims: { admin: boolean | null } | null;
  session: { admin: boolean | null };
}>(authorized: T): T {
  if (authorized.tenant.kind === "organization" || authorized.claims?.admin !== true || authorized.session.admin !== true)
    throw new Response("Platform administrator required", { status: 403 });
  return authorized;
}
