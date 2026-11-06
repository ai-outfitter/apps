# @ai-outfitter/server

The server-side request contract shared by the webapp, organization pages and
installed-app APIs: which tenant a host is, who is asking and what they may do,
and which rows they may see. Design and status:
[`docs/server-package.md`](../../docs/server-package.md).

The package owns the identity and tenancy tables, tenant resolution and the
host rules. `authorize()` itself still lives in the webapp
(`src/lib/authorize.ts`); moving it behind an injected runtime is a deferred
follow-up. Use the entry points below. `npm run lint` rejects the right-hand
column outside a short allowlist (`biome/*.grit`).

## Use this, not that

| Instead of | Use |
| --- | --- |
| Parsing `Host` or the URL to find the tenant | `requestTenant(request, locals)` (`src/lib/auth.ts`), or `resolveRequestTenant()` (`src/lib/tenancy.ts`) outside a request context |
| `auth.api.getSession(...)` or any `.getSession(` | `authenticated(request, { locals })` for any access check (wraps `authorize()` in `src/lib/authorize.ts`) |
| Reading the session cookie or `session` table yourself | `authorize(request, { locals?, fresh?, scoped? })` when you need the route's reads in the same batch; `authenticated()` otherwise |
| A display-only identity read (a page that renders without gating) | `currentSession(request, tenant, { locals })` |
| `db.select().from(member)` to check membership or a role | `authenticated()`: on an organization host it already checks membership and SSO |
| `db.select().from(member)` for membership as data (member lists, counts, another user's membership) | `organizationMembersQuery()`, `membershipQuery()`, `memberCount()` (`src/lib/organization-access.ts`) or `admittedMembershipsQuery()` (`src/lib/session-claims.ts`) |
| `db.select().from(session)` or `.from(domainSessions)` | `authenticated()` / `currentSession()`; vanity-domain sessions are handled in `src/lib/domain-session.ts` |
| Comparing `organizationId` in JavaScript after a query | `requireTenantResource(tenant, row.organizationId)` from `@ai-outfitter/server/hosts` |
| Building organization, app-host or login URLs by string | `organizationOrigin()`, `organizationOriginForAppHost()`, `managedAppHostname()`, `loginURL()`, `safeReturnPath()` from `@ai-outfitter/server/hosts` |
| Checking the canonical or OAuth origin by hand | `configuredOrigins()`, `canonicalURL()`, `oauthCallbackOrigin()`, `crossSubdomainCookieOptions()` from `@ai-outfitter/server/hosts` |
| Slug or reserved-name checks | `validOrganizationSlug()`, `RESERVED_ORGANIZATION_SLUGS` from `@ai-outfitter/server/hosts` |
| Installed-app checks in a template or API | `installedApp()`, `requireInstalledApp()`, `isOperationalInstallation()` from `@ai-outfitter/server/installation` |
| Platform administration access | `adminContext(request)` (`src/lib/admin.ts`, `platformAdministrator` in `src/lib/auth.ts`) authenticates once per request and applies shared `requirePlatformAdmin()` to the verified `claims.admin`; authority-changing writes read fresh facts. A positive claim the live session row no longer confirms is re-read from the facts, so revocations apply and claims never deny. Pages gate before reading data; `AdminLayout` also refuses to render (fail closed, no redirect). |
| Redefining identity or tenancy tables | `@ai-outfitter/server/schema` (re-exported by `src/db/schema.ts`) |

A missing or foreign row is a 404, never a 403 and never the row.

`authenticated(request, { locals, primary: true, verifyMembership: true })`
shares an in-flight primary membership decision within this operation, including
Astro rewrites. It exposes the verified role and organization purpose so thread
and installation admission do not query the same owner policy again. A sufficient
primary result satisfies an ordinary read; `fresh: true` starts a new decision.
Never retain locals or admitted hosts across HTTP, host RPC, tool or write
boundaries. Signed claims still require a live session/user check. App SDK
`requestIdentity()` trusts platform dispatch headers without fetching a user or
revalidating the browser credential.

## Entry points

| Import | Provides |
| --- | --- |
| `@ai-outfitter/server` | Everything below, plus `resolveRequestTenant`, `activeDomainRoute`, `validatedReturnURL`, `trustedAuthOrigins`, `postLoginDestination` |
| `@ai-outfitter/server/hosts` | Host, origin, cookie-zone, login-URL and tenant-resource rules |
| `@ai-outfitter/server/installation` | App-installation guard |
| `@ai-outfitter/server/schema` | Identity and tenancy tables |

## The lint

`biome/no-get-session.grit` rejects `.getSession(`. `biome/no-auth-table-reads.grit`
rejects `.from(session)`, `.from(member)` and `.from(domainSessions)`. Both
exempt `packages/server`, `tests/` and the modules that own the logic
(`src/lib/auth.ts`, `authorize.ts`, `session-claims.ts`, `domain-session.ts`,
`domain-handoff.ts`, `account-access.ts`, `organization-access.ts`, `sso.ts`).
Membership as data (an organization's member list or count, another user's
membership) reads through the named query builders in
`src/lib/organization-access.ts` and `src/lib/session-claims.ts`; do not add to
the list to silence a new violation.
The rules match by name: a renamed import, a destructured `getSession`,
writes (`insert`, `update`, `delete`) and a look-alike path under `catalog/`
that ends in an owner's path are not caught, so review still matters.
`tests/server-boundary-lint.test.ts` proves a violation fails.
