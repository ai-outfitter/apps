import type { InstalledApp, RequestTenant } from "./hosts";

/**
 * Installed mode is server state. `null` is a legacy, unclassified package,
 * which keeps its pages but never gains workflow or connector APIs.
 */
export const isOperationalInstallation = (installation: {
  mode?: string | null;
}) => installation.mode === "operational";

/**
 * The installation this request's own host serves, when it is the app host of
 * `template` (and, with `operational`, an operational package). Tenant
 * resolution already joined the row with its organization and required an
 * active script, so no further read is needed. Root, preview, organization and
 * vanity hosts have no installation.
 */
export function installedApp(
  tenant: RequestTenant,
  template: string,
  { operational = false }: { operational?: boolean } = {},
): InstalledApp | null {
  if (tenant.kind !== "organization") return null;
  const installation = tenant.installation;
  if (!installation || installation.template !== template) return null;
  if (operational && !isOperationalInstallation(installation)) return null;
  return installation;
}

/** `installedApp`, refusing with 404 so a handler cannot be reached from any other host. */
export function requireInstalledApp(
  tenant: RequestTenant,
  template: string,
  options?: { operational?: boolean },
): InstalledApp {
  const installation = installedApp(tenant, template, options);
  if (!installation) throw new Response("Not found", { status: 404 });
  return installation;
}
