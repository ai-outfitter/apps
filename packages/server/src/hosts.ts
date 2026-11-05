/**
 * Pure host and URL rules: no database, runtime or env binding, so templates
 * and browsers can import them too. Tenant resolution is in ./tenant.ts.
 */
import originHosts from "./origin-hosts.json";

export type Env = Record<string, string | undefined>;

/**
 * Labels under ai-outfitter.com served by their own origin, not the Worker:
 * the Spark tunnel and the inference gateway's ingress. Each needs a
 * Worker-less route (scripts/org-domain-routing.mjs reads the same file) and
 * is reserved from organizations here (docs/root-domain-cutover.md).
 */
export const ORIGIN_HOST_LABELS: readonly string[] = originHosts;

export const RESERVED_ORGANIZATION_SLUGS = new Set([
  "app",
  "www",
  "beta",
  "api",
  "auth",
  "admin",
  ...ORIGIN_HOST_LABELS,
  // Cloudflare for SaaS fallback origin and customer CNAME target.
  "domains",
]);

export type InstalledApp = {
  id: string;
  script: string;
  hostname?: string | null;
  // Content hash of the active package; null until one is recorded.
  hash: string | null;
  template: string;
  mode: "demo" | "operational" | null;
};
export type RequestTenant =
  | { kind: "root" | "preview"; rootOrigin: string }
  | {
      kind: "organization";
      rootOrigin: string;
      // mode is the installed package mode; null is a legacy, unclassified package.
      installation?: InstalledApp;
      /** Canonical same-origin mount, stripped before routing to the page or app. */
      pathPrefix?: string;
      // Present only on a verified organization vanity hostname.
      domain?: { id: string; hostname: string; generation: number };
      organization: {
        id: string;
        name: string;
        slug: string;
        logo: string | null;
      };
      /**
       * Resolved from session claims without a read (claimedTenant): `name`
       * and `logo` are placeholders and every query must prove the slug.
       */
      claimed?: true;
    };

export function validOrganizationSlug(slug: string) {
  return (
    slug.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    !RESERVED_ORGANIZATION_SLUGS.has(slug)
  );
}

export function configuredOrigins(env: Env) {
  return (env.OAUTH_PROXY_TRUSTED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
}

export function canonicalURL(env: Env) {
  if (!env.BETTER_AUTH_URL) throw new Error("Configure BETTER_AUTH_URL");
  return new URL(env.BETTER_AUTH_URL);
}

export function oauthCallbackOrigin(env: Env) {
  if (!env.OAUTH_CALLBACK_ORIGIN) return null;
  const root = env.OAUTH_PROXY_PRODUCTION_URL
    ? new URL(env.OAUTH_PROXY_PRODUCTION_URL)
    : canonicalURL(env);
  const callback = new URL(env.OAUTH_CALLBACK_ORIGIN);
  if (
    callback.protocol !== "https:" ||
    callback.origin !== env.OAUTH_CALLBACK_ORIGIN ||
    root.protocol !== "https:" ||
    callback.hostname !== `app.${root.hostname}` ||
    callback.port !== root.port
  )
    throw new Error(
      "OAUTH_CALLBACK_ORIGIN must be the HTTPS app subdomain origin",
    );
  return callback.origin;
}

export function isLocalHostname(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function managedAppHostname(
  template: string,
  orgSlug: string,
  rootOrigin: string,
) {
  const hostname = new URL(rootOrigin).hostname;
  return `${template}.${orgSlug}.${hostname}`;
}

/** Worker Preview hostnames: every branch preview is a flat label on this zone. */
export function isPreviewHostname(hostname: string) {
  return hostname.endsWith(".ai-outfitter.dev");
}

/**
 * The inverse of `managedAppHostname`: the organization origin for a page on
 * `<template>.<org>.<root>`, or null when `location` is not that app host.
 * Takes the parts of a browser `location` so templates can pass it directly.
 */
export function organizationOriginForAppHost(
  template: string,
  location: { protocol: string; hostname: string; port?: string },
) {
  const prefix = `${template}.`;
  if (!location.hostname.startsWith(prefix)) return null;
  const [slug, ...root] = location.hostname.slice(prefix.length).split(".");
  if (!slug || !root.length) return null;
  const port = location.port ? `:${location.port}` : "";
  try {
    return organizationOrigin(
      `${location.protocol}//${root.join(".")}${port}`,
      slug,
    );
  } catch {
    return null;
  }
}

/** Canonical organization and installed-app addresses on the main site. */
export function organizationPath(slug: string) {
  return `/o/${encodeURIComponent(slug)}`;
}

export function organizationAppPath(slug: string, app: string) {
  return `${organizationPath(slug)}/${encodeURIComponent(app)}`;
}

export function organizationOrigin(rootOrigin: string, slug: string) {
  return `${new URL(rootOrigin).origin}${organizationPath(slug)}`;
}

/** Convert a registered app hostname to its canonical main-site address. */
export function managedAppURL(rootOrigin: string, hostname: string) {
  const root = new URL(rootOrigin);
  const suffix = `.${root.hostname}`;
  if (!hostname.endsWith(suffix)) return null;
  const [app, slug, ...rest] = hostname.slice(0, -suffix.length).split(".");
  if (rest.length || !app || !slug || !validOrganizationSlug(app) || !validOrganizationSlug(slug)) return null;
  return `${root.origin}${organizationAppPath(slug, app)}/`;
}

export function isMachineApiPath(pathname: string) {
  return (
    pathname === "/api/inference/v1/models" ||
    pathname === "/api/inference/v1/chat/completions" ||
    /^\/api\/internal\/workflow-archives\/[^/]+$/.test(pathname) ||
    pathname === "/api/internal/github-deliveries/retry" ||
    pathname === "/api/internal/inference-usage" ||
    pathname === "/api/internal/inference/resolve" ||
    /^\/api\/internal\/apps\/[a-z0-9-]+\/deploy$/.test(pathname) ||
    /^\/api\/internal\/domains\/[a-z]+$/.test(pathname) ||
    pathname === "/api/webhooks/github" ||
    pathname === "/api/app-repositories/deploy"
  );
}

export function isLegacyAppURL(requestURL: URL, root: URL) {
  return (
    root.protocol === "https:" &&
    requestURL.protocol === root.protocol &&
    requestURL.hostname === `app.${root.hostname}` &&
    requestURL.port === root.port
  );
}

export function isLegacyMachineApiRequest(request: Request, env: Env) {
  const requestURL = new URL(request.url);
  return (
    isLegacyAppURL(requestURL, canonicalURL(env)) &&
    isMachineApiPath(requestURL.pathname)
  );
}

export function legacyRootRedirect(request: Request, env: Env) {
  const requestURL = new URL(request.url);
  const root = canonicalURL(env);
  if (
    !isLocalHostname(root.hostname) &&
    isLegacyAppURL(requestURL, root) &&
    !isMachineApiPath(requestURL.pathname)
  ) {
    root.pathname = requestURL.pathname;
    root.search = requestURL.search;
    return root;
  }
  return null;
}

export function requireTenantResource(
  tenant: RequestTenant,
  organizationId: string | null,
) {
  if (
    tenant.kind === "organization" &&
    tenant.organization.id !== organizationId
  )
    throw new Response("Not found", { status: 404 });
}

// Zones whose deployments share one Better Auth cookie. Production shares the
// root cookie with its organization subdomains. Previews do not: each has its
// own database, so its session cookies are host-only.
export const SHARED_COOKIE_ZONES = ["ai-outfitter.com", "outfitter.test"];

export function sharedCookieZone(hostname: string) {
  return SHARED_COOKIE_ZONES.find(
    (zone) => hostname === zone || hostname.endsWith(`.${zone}`),
  );
}

export function crossSubdomainCookieOptions(env: Env) {
  const root = canonicalURL(env);
  // Local app subdomains share the seeded session only in explicitly enabled development.
  if (env.OUTFITTER_LOCAL_DEV === "1" && env.NODE_ENV !== "production" && root.protocol === "http:" && root.hostname === "outfitter.localhost")
    return { enabled: true as const, domain: ".outfitter.localhost" };
  const zone = sharedCookieZone(root.hostname);
  if (root.protocol !== "https:" || !zone) return undefined;
  return { enabled: true as const, domain: `.${zone}` };
}

export const DOMAIN_LOGIN_PATH = "/auth/domain/start";

/** A relative same-origin path, or null. Rejects scheme-relative and backslash forms. */
export function safeReturnPath(value: string | null | undefined) {
  if (!value || value.length > 2048 || !value.startsWith("/")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in return paths.
  if (value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return null;
  const parsed = new URL(value, "https://return.invalid");
  if (parsed.origin !== "https://return.invalid") return null;
  const path = parsed.pathname + parsed.search;
  return path.startsWith("/auth/domain/") ? "/" : path;
}

/**
 * Where an unauthenticated browser goes to sign in. Platform hosts use the
 * canonical login page; a vanity host starts its own browser-bound handoff so
 * the canonical login never redirects to a host that cannot receive its cookie.
 */
export function loginURL(tenant: RequestTenant, returnTo: string | URL) {
  const target = new URL(returnTo);
  if (tenant.kind === "organization" && tenant.domain) {
    const start = new URL(DOMAIN_LOGIN_PATH, target.origin);
    start.searchParams.set(
      "returnTo",
      safeReturnPath(target.pathname + target.search) || "/",
    );
    return start;
  }
  const login = new URL("/login", tenant.rootOrigin);
  login.searchParams.set("returnTo", target.href);
  return login;
}

/**
 * Vanity-host restrictions applied before any route. Better Auth endpoints use
 * canonical cookies and stay on the canonical origin; login starts a handoff.
 */
export function domainHostGate(tenant: RequestTenant, url: URL) {
  if (tenant.kind !== "organization" || !tenant.domain) return null;
  // SAML initiation binds browser state to the canonical ACS; start it there.
  if (
    url.pathname === "/api/auth" ||
    url.pathname.startsWith("/api/auth/") ||
    url.pathname === "/api/sso"
  )
    return new Response("Not found", { status: 404 });
  if (url.pathname === "/auth/domain/handoff")
    return new Response("Not found", { status: 404 });
  if (url.pathname === "/login" || url.pathname === "/login/") {
    let returnTo = url.searchParams.get("returnTo") || "/";
    try {
      const absolute = new URL(returnTo, url.origin);
      returnTo = absolute.origin === url.origin ? absolute.pathname + absolute.search : "/";
    } catch {
      returnTo = "/";
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: loginURL(tenant, new URL(safeReturnPath(returnTo) || "/", url.origin)).href,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return null;
}
