import { and, eq, gt, isNotNull, type SQLWrapper, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  canonicalURL,
  configuredOrigins,
  DOMAIN_LOGIN_PATH,
  type Env,
  isLegacyAppURL,
  isLocalHostname,
  isMachineApiPath,
  isPreviewHostname,
  loginURL,
  organizationPath,
  organizationAppPath,
  type RequestTenant,
  validOrganizationSlug,
} from "./hosts";
import {
  appInstallations,
  organization,
  organizationDomains,
} from "./schema";

/** Any drizzle SQLite database the webapp runs on (D1 or libSQL). */
// biome-ignore lint/suspicious/noExplicitAny: the webapp's full schema is not known here.
export type Database = BaseSQLiteDatabase<"async", any, any>;

/** The organizations a request's verified session claims name, or null. */
export type ClaimedOrganizations = (
  request: Request,
) => Promise<{ id: string; slug: string }[] | null | undefined>;

/** Routing fails closed when no successful refresh confirmed the domain recently. */
export const DOMAIN_VERIFICATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * The only request-time domain lookup: an exact hostname read from the primary
 * database. It never calls Cloudflare and never consults edge metadata.
 */
export async function activeDomainRoute(
  db: Database,
  hostname: string,
  now = Date.now(),
) {
  const [found] = await db
    .select({
      domain: {
        id: organizationDomains.id,
        hostname: organizationDomains.hostname,
        generation: organizationDomains.generation,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
      },
    })
    .from(organizationDomains)
    .innerJoin(
      organization,
      eq(organization.id, organizationDomains.organizationId),
    )
    .where(
      and(
        eq(organizationDomains.hostname, hostname),
        eq(organizationDomains.lifecycle, "provisioned"),
        eq(organizationDomains.routingEnabled, true),
        gt(organizationDomains.verifiedAt, now - DOMAIN_VERIFICATION_MAX_AGE_MS),
      ),
    );
  return found ?? null;
}

async function resolveCustomDomainTenant(
  requestURL: URL,
  db: Database,
  root: URL,
): Promise<RequestTenant> {
  // Customer hostnames are exact HTTPS registrations; the incoming URL host is
  // the only selector, never a forwarded header.
  if (requestURL.protocol !== "https:" || requestURL.port)
    throw new Response("Unknown host", { status: 404 });
  const route = await activeDomainRoute(db, requestURL.hostname);
  if (!route) throw new Response("Unknown host", { status: 404 });
  if (isMachineApiPath(requestURL.pathname))
    throw new Response("Not found", { status: 404 });
  return {
    kind: "organization",
    rootOrigin: root.origin,
    organization: route.organization,
    domain: route.domain,
  };
}

async function subdomainTarget(requestURL: URL, db: Database, suffix: string) {
  const slug = requestURL.hostname.slice(0, -suffix.length);
  if (!slug.includes("."))
    return { slug, organization: undefined, installation: undefined };
  const parts = slug.split(".");
  if (
    parts.length !== 2 ||
    !validOrganizationSlug(parts[0]) ||
    !validOrganizationSlug(parts[1])
  )
    throw new Response("Unknown app", { status: 404 });
  // One read: the installation and its organization.
  const [app] = await db
    .select({
      id: appInstallations.id,
      script: appInstallations.activeScript,
      hash: appInstallations.activeHash,
      template: appInstallations.template,
      mode: appInstallations.mode,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
      },
    })
    .from(appInstallations)
    .innerJoin(organization, eq(organization.id, appInstallations.organizationId))
    .where(
      and(
        eq(appInstallations.hostname, requestURL.hostname),
        isNotNull(appInstallations.activeScript),
      ),
    );
  if (
    !app?.script ||
    app.template !== parts[0] ||
    app.organization.slug !== parts[1]
  )
    throw new Response("Unknown app", { status: 404 });
  return {
    slug: app.organization.slug,
    organization: app.organization,
    installation: {
      id: app.id,
      script: app.script,
      hash: app.hash,
      template: app.template,
      mode: app.mode,
    },
  };
}

// A server-selected organization on a flat internal preview hostname. No browser
// header, query parameter or active-session organization can select the tenant.
async function internalPreviewOrganization(url: URL, db: Database, env: Env): Promise<RequestTenant | null> {
  if (env.PREVIEW_INTERNAL !== "true" || !env.PREVIEW_ORGANIZATION_SLUG)
    return null;
  if (!isPreviewHostname(url.hostname) && !isLocalHostname(url.hostname))
    throw new Response("Internal preview hostname required", { status: 403 });
  // Organization previews must keep Google pages and actions in their org scope.
  // Installed-app previews retain their existing personal connector escape hatch.
  const appGoogle = env.PREVIEW_APP_TEMPLATE &&
    (url.pathname.replace(/\/$/, "") === "/connectors/google" || url.pathname.startsWith("/api/connectors/google/"));
  if (["/login", "/logout", "/organizations", "/api/admin", "/api/health"].includes(url.pathname.replace(/\/$/, "")) ||
      appGoogle ||
      url.pathname.startsWith("/api/auth/") || (!env.PREVIEW_APP_TEMPLATE && url.pathname.startsWith("/_astro/")))
    return null;
  const [found] = await db.select({ id: organization.id, name: organization.name,
    slug: organization.slug, logo: organization.logo, purpose: organization.purpose }).from(organization)
    .where(eq(organization.slug, env.PREVIEW_ORGANIZATION_SLUG));
  if (!found) throw new Response("Configure the internal preview organization", { status: 503 });
  if (env.PREVIEW_APP_TEMPLATE) {
    if (found.purpose !== "operational") throw new Response("Operational preview organization required", { status: 503 });
    // Operator-selected app and organization, never a cookie, header or query.
    // Normal installed-app admission and dispatch run after resolving this tenant.
    const [app] = await db.select().from(appInstallations).where(and(
      eq(appInstallations.organizationId, found.id),
      eq(appInstallations.template, env.PREVIEW_APP_TEMPLATE),
      eq(appInstallations.mode, "operational"),
      isNotNull(appInstallations.activeScript),
      isNotNull(appInstallations.activeHash),
    ));
    if (!app?.activeScript) throw new Response("Operational preview installation unavailable", { status: 503 });
    return { kind: "organization", rootOrigin: url.origin, organization: found,
      installation: { id: app.id, script: app.activeScript, hash: app.activeHash,
        template: app.template, mode: app.mode } };
  }
  return { kind: "organization", rootOrigin: url.origin, organization: found };
}

// Routes whose tenant-scoped queries all prove the host slug in SQL
// (tenantOrganizationIs and a branding row). Reads only. The former chat pages
// were the only ones; their entry routes now resolve the tenant from the
// database before provisioning or redirecting into Chat, so none is listed.
const CLAIMED_TENANT_ROUTES: readonly RegExp[] = [];

/**
 * An organization subdomain resolved from the session claims, with no
 * database read: the request's verified cookie cache claims an organization
 * whose slug is the host's. The claim is only a hint. The id may be stale,
 * so every query on these routes also requires `organization.slug` to equal
 * the host slug, and a renamed or reused slug returns no rows. `name` is the
 * slug until the page's branding row replaces it.
 */
async function claimedTenant(
  request: Request,
  requestURL: URL,
  claimedOrganizations: ClaimedOrganizations | undefined,
  slug: string,
  root: URL,
): Promise<RequestTenant | null> {
  if (
    !claimedOrganizations ||
    !["GET", "HEAD"].includes(request.method) ||
    !CLAIMED_TENANT_ROUTES.some((route) => route.test(requestURL.pathname))
  )
    return null;
  const claimed = (await claimedOrganizations(request))?.find(
    (entry) => entry.slug === slug,
  );
  if (!claimed) return null;
  return {
    kind: "organization",
    rootOrigin: root.origin,
    organization: { id: claimed.id, name: slug, slug, logo: null },
    claimed: true,
  };
}

/**
 * Rows that belong to the host's organization. For a claimed tenant the same
 * statement also proves the host slug still names that organization.
 */
export function tenantOrganizationIs(
  column: SQLWrapper,
  tenant: Extract<RequestTenant, { kind: "organization" }>,
) {
  const same = sql`${column} = ${tenant.organization.id}`;
  if (!tenant.claimed) return same;
  return and(
    same,
    sql`exists (select 1 from ${organization} where ${organization.id} = ${tenant.organization.id} and ${organization.slug} = ${tenant.organization.slug})`,
  );
}

// Organization utilities share the organization's mount; other second segments
// name installed apps. Keep these platform routes ahead of app resolution.
export const ORGANIZATION_ROUTES: ReadonlySet<string> = new Set([
  "api", "_astro", "app-covers", "images", "fonts", "apps", "c", "p", "templates", "plugins",
  "connectors", "communities", "workflow-runs", "routines", "workflows", "settings",
  "organizations", "__outfitter_route.js", "_server-islands",
]);

/** Tenant resolution options. `defaultMounts` are the catalog default apps' mounts
 * (`/o/<org>/<mount>`): before the organization's installation exists, such a
 * path resolves to the organization's own routes, which provision it. */
export type TenantOptions = { defaultMounts?: ReadonlySet<string> };

async function pathTenant(url: URL, db: Database, root: URL, options: TenantOptions = {}): Promise<RequestTenant | null> {
  if (!/^\/o(?:\/|$)/.test(url.pathname)) return null;
  const match = /^\/o\/([a-z0-9-]+)(?:\/([^/]+))?(?:\/.*)?$/.exec(url.pathname);
  if (!match || !validOrganizationSlug(match[1])) throw new Response("Unknown organization", { status: 404 });
  const [, slug, appSlug] = match;
  const [found] = await db.select({ id: organization.id, name: organization.name,
    slug: organization.slug, logo: organization.logo }).from(organization).where(eq(organization.slug, slug));
  if (!found) throw new Response("Unknown organization", { status: 404 });
  const base = { kind: "organization" as const, rootOrigin: root.origin, organization: found };
  if (!appSlug || ORGANIZATION_ROUTES.has(appSlug)) return { ...base, pathPrefix: organizationPath(slug) };
  // The app's slug: its template until renamed (src/lib/app-slugs.ts).
  const [app] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.organizationId, found.id),
    eq(sql`coalesce(${appInstallations.slug}, ${appInstallations.template})`, appSlug),
    isNotNull(appInstallations.activeScript),
  ));
  if (!app?.activeScript) {
    if (options.defaultMounts?.has(appSlug)) return { ...base, pathPrefix: organizationPath(slug) };
    throw new Response("Unknown app", { status: 404 });
  }
  return { ...base, pathPrefix: organizationAppPath(slug, appSlug), installation: {
    id: app.id, script: app.activeScript, hostname: app.hostname, hash: app.activeHash, template: app.template, mode: app.mode,
  } };
}

/**
 * Which tenant a request's host is. `claimedOrganizations` lets organization
 * chat routes resolve from the session claims without a read.
 */
export async function resolveRequestTenant(
  request: Request,
  db: Database,
  env: Env,
  claimedOrganizations?: ClaimedOrganizations,
  options: TenantOptions = {},
): Promise<RequestTenant> {
  const requestURL = new URL(request.url);
  const root = canonicalURL(env);
  if (requestURL.origin === root.origin) {
    return await pathTenant(requestURL, db, root, options) ??
      await internalPreviewOrganization(requestURL, db, env) ??
      { kind: "root", rootOrigin: root.origin };
  }

  if (isLegacyAppURL(requestURL, root) && isMachineApiPath(requestURL.pathname))
    return { kind: "root", rootOrigin: root.origin };

  if (configuredOrigins(env).includes(requestURL.origin))
    return { kind: "preview", rootOrigin: root.origin };

  const suffix = `.${root.hostname}`;
  if (!requestURL.hostname.endsWith(suffix))
    return resolveCustomDomainTenant(requestURL, db, root);
  if (requestURL.protocol !== root.protocol || requestURL.port !== root.port)
    throw new Response("Unknown host", { status: 404 });
  const target = await subdomainTarget(requestURL, db, suffix);
  const { slug } = target;
  if (!validOrganizationSlug(slug))
    throw new Response("Unknown host", { status: 404 });
  if (isMachineApiPath(requestURL.pathname))
    throw new Response("Not found", { status: 404 });
  if (target.installation)
    return {
      kind: "organization",
      rootOrigin: root.origin,
      organization: target.organization,
      installation: target.installation,
    };
  const claimed = await claimedTenant(
    request,
    requestURL,
    claimedOrganizations,
    slug,
    root,
  );
  if (claimed) return claimed;
  const [found] = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
    })
    .from(organization)
    .where(eq(organization.slug, slug));
  if (!found) throw new Response("Unknown organization", { status: 404 });
  return { kind: "organization", rootOrigin: root.origin, organization: found };
}

/** Navigation return URLs. Active vanity hosts are allowed unless `allowVanity` is false. */
export async function validatedReturnURL(
  value: string | null | undefined,
  db: Database,
  env: Env,
  { allowVanity = true } = {},
) {
  if (!value) return null;
  const root = canonicalURL(env);
  let target: URL;
  try {
    target = new URL(value, root.origin);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    return null;
  try {
    const tenant = await resolveRequestTenant(new Request(target), db, env);
    if (!allowVanity && tenant.kind === "organization" && tenant.domain)
      return null;
    return target.href;
  } catch {
    return null;
  }
}

export async function trustedAuthOrigins(
  request: Request | undefined,
  db: Database,
  env: Env,
) {
  const root = canonicalURL(env);
  const trusted = new Set([root.origin, ...configuredOrigins(env)]);
  if (!request) return [...trusted];
  const candidates = [request.headers.get("origin")];
  if (!["GET", "HEAD"].includes(request.method)) {
    try {
      const body = (await request.clone().json()) as Record<string, unknown>;
      for (const key of [
        "callbackURL",
        "redirectTo",
        "errorCallbackURL",
        "newUserCallbackURL",
      ])
        if (typeof body[key] === "string") candidates.push(body[key] as string);
    } catch {
      // Non-JSON callbacks do not contain browser-controlled return URLs.
    }
  }
  // Better Auth uses these origins for mutation CSRF checks as well as
  // callbacks. A vanity domain is a navigation destination only: it never
  // receives canonical auth cookies and must not gain mutation trust.
  for (const candidate of candidates) {
    const valid = await validatedReturnURL(candidate, db, env, {
      allowVanity: false,
    });
    if (valid) trusted.add(new URL(valid).origin);
  }
  return [...trusted];
}

/**
 * Where the canonical login page sends a browser afterwards. A vanity host
 * re-enters through its handoff start, and its origin is reported so callers
 * never hand it to Better Auth as a trusted callback origin.
 */
export async function postLoginDestination(
  value: string | null | undefined,
  db: Database,
  env: Env,
) {
  const valid = await validatedReturnURL(value, db, env);
  if (!valid) return null;
  const tenant = await resolveRequestTenant(new Request(valid), db, env);
  if (tenant.kind !== "organization" || !tenant.domain)
    return { href: valid, vanity: false };
  const target = new URL(valid);
  return {
    href:
      target.pathname === DOMAIN_LOGIN_PATH
        ? target.href
        : loginURL(tenant, target).href,
    vanity: true,
  };
}
