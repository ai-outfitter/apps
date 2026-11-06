import {
  organizationOriginFor,
  setOrganizationLink,
} from "../../navigation.js";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { fixtureResponse } from "./fixtures.js";
// A constant, so a demo build drops every network call.
const demoBuild = import.meta.env.OUTFITTER_APP_MODE === "demo";
const pageMode = () =>
  demoBuild ||
  document.querySelector('meta[name="outfitter-preview-mode"]')?.content ===
    "demo";
export let demoMode = pageMode();
const el = (id) => document.getElementById(id);
// Null off an app host: organization links are hidden rather than pointing
// the app at itself.
const organizationOrigin =
  document.querySelector('meta[name="outfitter-platform-origin"]')?.content ||
  organizationOriginFor("software-foundry");
setOrganizationLink("software-foundry");
function organizationLink(selector, path) {
  document.querySelectorAll(selector).forEach((link) => {
    if (organizationOrigin) link.href = `${organizationOrigin}${path}`;
    else link.hidden = true;
  });
}
onPageLoad(() => {
  // A preview's mode switch swaps in a page of the other mode.
  demoMode = pageMode();
  organizationLink("[data-settings]", "/plugins/github");
  organizationLink("[data-forgejo-settings]", "/connectors/forgejo");
});
async function api(path, options = {}) {
  if (demoBuild || demoMode) return fixtureResponse(path, options);
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const PROJECT_KEY = "software-foundry.project";
export function storedProject() {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}
export function rememberProject(id) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {}
}
/**
 * The project a page asks for: the URL's, else the last one picked. The
 * dashboard passes `remembered: false` to open the highest priority project.
 */
export function requestedProject(remembered = true) {
  const named = new URL(location.href).searchParams.get("project");
  return named || (remembered ? storedProject() : null);
}

/**
 * The page's first render: the platform's GitHub view and, from this app, the
 * Foundry projects with the active project's ranked milestones and the page's
 * first data. Only organization admins get page data; for anyone else, or if
 * it fails, the page falls back to the GitHub view and its own endpoints.
 */
export async function loadPage(page, params = {}, { remembered = true } = {}) {
  const query = new URLSearchParams({ page });
  const project = requestedProject(remembered);
  if (project) query.set("project", project);
  for (const [key, value] of Object.entries(params))
    if (value !== null && value !== undefined && value !== "")
      query.set(key, String(value));
  // The organization's GitHub view is the platform's; the page data is this app's.
  const [plugin, data] = await Promise.all([
    api("/api/plugins/github"),
    api(`/api/apps/software-foundry/bootstrap?${query}`).catch(() => ({ page })),
  ]);
  return { ...data, plugin };
}

export function availableRepositories(plugin) {
  return plugin.repositories || [];
}

export function text(tag, value = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

/** A link that opens outside the app, without handing it the opener. */
export function external(label, href, className) {
  const link = text("a", label, className);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

export { api, el, organizationOrigin };
