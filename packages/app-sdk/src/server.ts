import { readText } from "@ai-outfitter/connector-core/http";
import { z } from "zod";

/** Original browser URL, supplied only by authenticated platform page dispatch.
 * Navigation context only; the URL never grants identity or authority. */
export const pageURLHeader = "x-outfitter-page-url";
export function requestPageURL(request: Request): URL {
  return new URL(request.headers.get(pageURLHeader) ?? request.url);
}

// The server side shared by apps that keep their records in their own
// installation database. The platform is the front door: it authenticates the
// member, checks the installation and forwards the verified identity in these
// headers. A dispatch-namespace Worker has no route of its own, so only the
// platform can reach it and set them (docs/app-databases.md).
export const identityHeaders = {
  user: "x-outfitter-user",
  organization: "x-outfitter-organization",
  installation: "x-outfitter-installation",
  role: "x-outfitter-role",
  // The caller's access to this installation (`AppAccess`), resolved by the
  // platform from the organization's grants. An older platform sends none.
  access: "x-outfitter-app-access",
  // `<kind>:<id>` of the installation's one owner. An older platform sends
  // none; its apps are all organization-owned.
  owner: "x-outfitter-owner",
  entityWriter: "x-outfitter-entity-writer",
  // The authenticated caller acting for the member on a dispatch-only route
  // (an OAuth client or another app) and the caller that initiated the chain.
  // Absent means the member. Only the platform sets them.
  actor: "x-outfitter-actor",
  originActor: "x-outfitter-origin-actor",
  // The caller's own organization when a member of another organization calls
  // this organization's installation (role `external`). Only the platform sets
  // it, after checking the caller's current membership of that organization.
  callerOrganization: "x-outfitter-caller-organization",
} as const;

/** Who made a call for `userId`. The platform verifies it; request bodies never supply it.
 * `platform` is the platform's own work, such as installation setup after a
 * deployment: `userId` is then a service actor, never a person or a member. */
export const appActor = z.strictObject({
  kind: z.enum(["member", "oauth-client", "app", "platform"]),
  id: z.string().min(1).max(256),
  /** Display only, e.g. an OAuth client's self-described name. */
  label: z.string().max(200).optional(),
});
export type AppActor = z.infer<typeof appActor>;

export const encodeActor = (actor: AppActor) =>
  encodeURIComponent(JSON.stringify({ kind: actor.kind, id: actor.id, ...(actor.label ? { label: actor.label.slice(0, 200) } : {}) }));

function forwardedActor(request: Request, header: string): AppActor | undefined {
  const value = request.headers.get(header);
  if (!value) return undefined;
  try { return appActor.parse(JSON.parse(decodeURIComponent(value))); }
  catch { throw new Response("Unauthorized", { status: 401 }); }
}

/** The verified immediate caller: the forwarded actor or, without one, the member. */
export function requestActor(request: Request, identity: Pick<AppIdentity, "userId">): AppActor {
  return forwardedActor(request, identityHeaders.actor) ?? { kind: "member", id: identity.userId };
}

/** A verified resident agent's platform user ID:
 * `resident:<identity-installation>:<resident-id>`. Only the platform mints it,
 * after its resident verifier confirms the resident; it names an agent, never a
 * member or a role. Apps recognise it; request data never selects one. */
export const residentPrincipalId = (identityInstallationId: string, residentId: string) =>
  `resident:${identityInstallationId}:${residentId}`;
export const isResidentPrincipal = (userId: string) => userId.startsWith("resident:");

/** The caller that initiated this chain, kept across trusted app-to-app dispatch.
 * Attribution only: it never adds to the member's or package's authority. */
export function requestOriginActor(request: Request, identity: Pick<AppIdentity, "userId">): AppActor {
  return forwardedActor(request, identityHeaders.originActor) ?? requestActor(request, identity);
}

/** What a person may do in one installed app. A caller with `none` never
 * reaches the app: the platform answers 404, as for an app they cannot see. */
export type AppAccess = "none" | "read" | "write" | "admin";
const accessLevels: readonly AppAccess[] = ["none", "read", "write", "admin"];
const isAccess = (value: string): value is AppAccess => (accessLevels as readonly string[]).includes(value);

/** Access a role has without a grant: owners and admins administer, any other role reads. */
export const defaultAppAccess = (role: string): AppAccess => (role === "owner" || role === "admin" ? "admin" : "read");

/** The highest of several accesses; none for an empty list. */
export const highestAppAccess = (values: AppAccess[]): AppAccess =>
  values.reduce<AppAccess>((best, value) => (accessLevels.indexOf(value) > accessLevels.indexOf(best) ? value : best), "none");

/** A role list's access without grants (Better Auth stores several roles comma-separated). */
export const rolesAppAccess = (role: string) => highestAppAccess(role.split(",").map(defaultAppAccess));

/** Who an installation belongs to: an organization, or a single user. */
export type AppOwner = { kind: "organization" | "user"; id: string };

/** Who is calling, by id only. Pages are routed by organization and app slug, which
 * apps never receive, so a page link built from these ids is broken: return links
 * relative to the installation (such as `changes/<id>`, no leading slash) under
 * `url` or `*Url` keys, and the platform resolves them to the real page. */
export type AppIdentity = {
  userId: string;
  /** Set on an organization-owned installation; absent on a user's app. */
  organizationId?: string;
  owner: AppOwner;
  installationId: string;
  /** The member's organization role, or "owner" for a user app's owner. */
  role: string;
  /** The caller's access to this installation. requestIdentity always sets it; an
   * identity built by hand (a test fixture) may leave it out for the role's default. */
  access?: Exclude<AppAccess, "none">;
  /** Write or admin access: an organization owner or admin by default, or a user app's owner. */
  canEdit: boolean;
  /** Trusted app-to-app entity delegation, never a platform admin role. */
  entityWriter?: string;
  /** Set only with role `external`: the caller is a member of this other
   * organization, not of the installation's organization, and may run only
   * actions the app marks `external`. The app decides whom it serves. */
  callerOrganizationId?: string;
};

/** An identity on an organization-owned installation. */
export type OrganizationIdentity = AppIdentity & { organizationId: string };

/** Headers the platform sets on every forwarded app API request. Without an
 * owner, the installation is `organizationId`'s. */
export function identityHeaderValues(
  identity: Omit<AppIdentity, "canEdit" | "owner" | "access"> & { owner?: AppOwner; access?: AppAccess },
) {
  const owner = identity.owner ?? { kind: "organization", id: identity.organizationId ?? "" };
  return {
    [identityHeaders.user]: identity.userId,
    [identityHeaders.organization]: owner.kind === "organization" ? owner.id : "",
    [identityHeaders.installation]: identity.installationId,
    [identityHeaders.role]: identity.role,
    [identityHeaders.owner]: `${owner.kind}:${owner.id}`,
    ...(identity.access ? { [identityHeaders.access]: identity.access } : {}),
    ...(identity.entityWriter ? { [identityHeaders.entityWriter]: identity.entityWriter } : {}),
    ...(identity.callerOrganizationId ? { [identityHeaders.callerOrganization]: identity.callerOrganizationId } : {}),
  };
}

function requestOwner(owner: string, organizationId: string): AppOwner | undefined {
  if (!owner) return organizationId ? { kind: "organization", id: organizationId } : undefined;
  const separator = owner.indexOf(":");
  const kind = owner.slice(0, separator);
  const id = owner.slice(separator + 1);
  if (separator < 1 || !id) return undefined;
  // The organization header always names an organization owner, and only one.
  if (kind === "organization" && id === organizationId) return { kind, id };
  if (kind === "user" && !organizationId) return { kind, id };
  return undefined;
}

export function requestIdentity(request: Request): AppIdentity {
  const value = (name: string) => request.headers.get(name) ?? "";
  const userId = value(identityHeaders.user);
  const installationId = value(identityHeaders.installation);
  const role = value(identityHeaders.role);
  const owner = requestOwner(value(identityHeaders.owner), value(identityHeaders.organization));
  // Without the header (an older platform) the role's default applies.
  const access = value(identityHeaders.access) || rolesAppAccess(role);
  if (!userId || !installationId || !role || !owner || !isAccess(access) || access === "none")
    throw new Response("Unauthorized", { status: 401 });
  // A call from another organization names it; nothing else carries one.
  const caller = value(identityHeaders.callerOrganization);
  if ((role === "external") !== Boolean(caller) || (caller && owner.kind !== "organization"))
    throw new Response("Unauthorized", { status: 401 });
  return {
    userId,
    ...(owner.kind === "organization" ? { organizationId: owner.id } : {}),
    owner,
    installationId,
    role,
    access,
    canEdit: access !== "read",
    ...(value(identityHeaders.entityWriter) ? { entityWriter: value(identityHeaders.entityWriter) } : {}),
    ...(caller ? { callerOrganizationId: caller } : {}),
  };
}

/** The identity on an organization-owned installation; a user's app is not found. */
export function requireOrganization(identity: AppIdentity): OrganizationIdentity {
  if (!identity.organizationId) throw new Response("Not found", { status: 404 });
  return identity as OrganizationIdentity;
}

export function requireEditor(identity: AppIdentity) {
  if (!identity.canEdit)
    throw new Response("Owner or admin required", { status: 403 });
}

/** At least `level` access to this app, e.g. `admin` for its settings. */
export function requireAccess(identity: Pick<AppIdentity, "access" | "role">, level: Exclude<AppAccess, "none">) {
  if (accessLevels.indexOf(identity.access ?? rolesAppAccess(identity.role)) < accessLevels.indexOf(level))
    throw new Response(`${level[0].toUpperCase()}${level.slice(1)} access required`, { status: 403 });
}

/** Parses a bounded JSON body; any failure is a 400 without detail. */
export async function readJSON<T>(
  request: Pick<Request, "body">,
  schema: z.ZodType<T>,
  limit: number,
): Promise<T> {
  const text = await readText(request, limit);
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Response("Invalid input", { status: 400 });
  }
}

/** Runs a handler; a thrown Response is the answer and a value becomes JSON. */
export async function respond(work: () => Promise<unknown>) {
  let response: Response;
  try {
    const result = await work();
    response =
      result instanceof Response ? result : Response.json(result ?? null);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/** Drivers wrap SQLite constraint errors, so check the whole cause chain. */
export function isUniqueViolation(error: unknown) {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if (/unique constraint/i.test(cause.message)) return true;
  return false;
}

/** Lowercase hex SHA-256 of text or bytes. */
export async function sha256Hex(value: string | BufferSource) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Entity delegation permits data writes, never configuration or admin actions. */
export function requireEntityWriter(identity: AppIdentity) {
  if (!identity.entityWriter) requireEditor(identity);
}

/** Trusted dispatch-only development visibility; browser headers are not forwarded. */
export const diagnosticsHeader = "x-outfitter-developer-diagnostics";
export const appDiagnosticsEnabled = (request: Request) => request.headers.get(diagnosticsHeader) === "1";
