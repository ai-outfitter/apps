import { disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { organizationOriginForAppHost } from "@ai-outfitter/server/hosts";

const organization = document.getElementById("org") as HTMLAnchorElement | null;
const origin = organizationOriginForAppHost("onto", location);
if (organization && origin) organization.href = origin;
else if (organization) organization.hidden = true;

document.addEventListener("astro:before-swap", () => disposeKnowledgeGraphViewers(document));
document.addEventListener("astro:page-load", () => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("#wiki-sidebar-records a[href]")) {
    const path = link.dataset.rootPath ?? new URL(link.href).pathname;
    const active = location.pathname === path || (!link.classList.contains("chat-link") && location.pathname.startsWith(`${path}/`));
    if (active) {
      link.setAttribute("aria-current", "page");
    } else link.removeAttribute("aria-current");
  }
});
