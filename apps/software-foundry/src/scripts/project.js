import { availableRepositories, el, rememberProject } from "./shared.js";

// A Foundry project is a named group of available repositories. Every page's
// bootstrap carries the organization's projects, highest priority first, and
// the active project's open milestones ranked most important first.
const SIDEBAR_MILESTONES = 3;

/**
 * A project milestone's page: its first repository's GitHub milestone on the
 * Milestones page. The milestones list without one.
 */
export function milestoneHref(milestone) {
  const part = milestone?.parts?.[0];
  if (!part) return "/milestones";
  const params = new URLSearchParams({
    repository: part.repository,
    milestone: String(part.number),
  });
  return `/milestones?${params}`;
}

function renderPicker(projects, active) {
  const picker = el("project");
  picker.replaceChildren(
    ...projects.map((project) => new Option(project.name, project.id)),
  );
  if (!active) {
    picker.append(new Option("No projects", ""));
    return;
  }
  picker.value = active.id;
  picker.disabled = projects.length < 2;
  picker.onchange = () => {
    rememberProject(picker.value);
    location.assign(
      `${location.pathname}?${new URLSearchParams({ project: picker.value })}`,
    );
  };
}

function renderMilestones(milestones) {
  const params = new URL(location.href).searchParams;
  const current = `${params.get("repository")}#${params.get("milestone")}`;
  el("project-milestones").replaceChildren(
    ...milestones.slice(0, SIDEBAR_MILESTONES).map((milestone) => {
      const link = document.createElement("a");
      link.className = "chat-link";
      link.href = milestoneHref(milestone);
      link.textContent = milestone.title;
      if (
        milestone.parts.some(
          (part) => `${part.repository}#${part.number}` === current,
        )
      )
        link.setAttribute("aria-current", "page");
      return link;
    }),
  );
  el("project-milestones-empty").hidden = milestones.length > 0;
}

function emptySidebar(message) {
  renderPicker([], null);
  for (const title of document.querySelectorAll("[data-project-title]"))
    title.textContent = "No project";
  el("project-milestones-empty").textContent = message;
}

/** Why a page has no project to show, from its bootstrap. */
export function projectNotice(page) {
  if (page?.foundry)
    return "Create a project in Settings: name it and choose its repositories.";
  if (page?.plugin?.organization?.canEdit === false)
    return "An organization administrator can browse projects.";
  if (page?.plugin && !availableRepositories(page.plugin).length)
    return "Approve a repository in Settings, then create a project.";
  return "Projects could not be loaded. Reload to retry.";
}

/**
 * Render the project picker, header and the active project's first ranked
 * milestones from a page bootstrap. Returns the active project with its
 * ranked milestones, or null when there is none to show.
 */
export function initProject(page) {
  const foundry = page?.foundry;
  if (!foundry) {
    emptySidebar(projectNotice(page));
    return null;
  }
  const active = foundry.projects.find(
    (project) => project.id === foundry.active,
  );
  if (!active) {
    emptySidebar(projectNotice(page));
    return null;
  }
  // Only an explicit pick is remembered; a page's default is not.
  if (new URL(location.href).searchParams.get("project") === active.id)
    rememberProject(active.id);
  renderPicker(foundry.projects, active);
  for (const title of document.querySelectorAll("[data-project-title]"))
    title.textContent = active.name;
  if (foundry.error)
    el("project-milestones-empty").textContent =
      "Milestones could not be loaded.";
  else renderMilestones(foundry.milestones);
  return { ...active, milestones: foundry.milestones, foundry };
}
