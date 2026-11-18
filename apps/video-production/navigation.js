import { organizationOriginForAppHost } from "@ai-outfitter/server/hosts";

export function organizationOriginFor(template) {
  const mounted = /^\/o\/([^/]+)\//.exec(location.pathname);
  return mounted ? `${location.origin}/o/${mounted[1]}` : organizationOriginForAppHost(template, location);
}

export function setOrganizationLink(template) {
  const origin = organizationOriginFor(template);
  const link = document.getElementById("org");
  if (!link) return;
  if (origin) link.href = origin;
  else link.hidden = true;
}
