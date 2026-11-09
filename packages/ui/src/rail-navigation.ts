import type { IconName } from "./icons";

export type RailOrganization = { name: string; href: string; current?: string };
export type RailLink = { key: string; label: string; href: string; icon: IconName };

/** Destinations come from the platform's explicit owner context, never the page path. */
export function railNavigation(rootOrigin: string, organization?: RailOrganization) {
  const root = new URL(rootOrigin);
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password) throw new Error("Invalid platform origin");
  const org = organization ? new URL(organization.href) : null;
  if (org && (org.origin !== root.origin || !/^\/o\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(org.pathname) || org.search || org.hash)) throw new Error("Invalid organization destination");
  const prefix = org?.pathname.replace(/\/$/, "") ?? "";
  const entries: { key: string; path: string; label: string; icon: IconName }[] = organization ? [
    { key: "home", path: "", label: "Organization home", icon: "home" },
    { key: "wiki", path: "/wiki", label: "Organization Wiki", icon: "book" },
    { key: "workflows", path: "/workflows", label: "Organization workflows", icon: "workflow" },
    { key: "apps", path: "/apps", label: "Organization apps", icon: "plugins" },
    { key: "settings", path: "/settings", label: "Organization settings", icon: "settings" },
  ] : [
    { key: "home", path: "/", label: "Home", icon: "home" },
    { key: "for-you", path: "/for-you", label: "For you", icon: "spark" },
    { key: "automations", path: "/automations", label: "Automations", icon: "workflow" },
    { key: "wiki", path: "/wiki", label: "Wiki", icon: "book" },
    { key: "organizations", path: "/organizations", label: "Teams / orgs", icon: "organization" },
  ];
  return {
    label: organization ? `${organization.name} organization` : "Personal",
    organization,
    links: entries.map(({ path, ...link }): RailLink => ({ ...link, href: new URL(prefix + path, root.origin).href })),
    personalHref: organization ? new URL("/", root.origin).href : null,
  };
}
