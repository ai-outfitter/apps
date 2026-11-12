import { requestPageURL } from "@ai-outfitter/app-sdk/server";
import { organizationOriginForAppHost } from "@ai-outfitter/server/hosts";

/** Preserve the caller's platform workspace; these URLs never select data authority. */
export function platformHref(request: Request, path: string) {
  const page = requestPageURL(request);
  const organization = /^\/o\/([^/]+)(?:\/|$)/.exec(page.pathname);
  const root = organization ? `${page.origin}/o/${organization[1]}` : organizationOriginForAppHost("forerunner", page) ?? page.origin;
  return `${root}${path}`;
}
