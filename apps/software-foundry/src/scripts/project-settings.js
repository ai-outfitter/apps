import { api, availableRepositories, demoMode, el } from "./shared.js";

// Create, rename, reorder and delete Foundry projects. The first project is
// the highest priority. Writes go to the same API agents use.
const PROJECTS = "/api/apps/software-foundry/projects";
let projects = [];
let editing = null;
let canEdit = false;

function text(tag, value = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function button(label, onClick, name = label) {
  const node = text("button", label, "secondary");
  node.type = "button";
  node.setAttribute("aria-label", name);
  node.disabled = !canEdit;
  node.onclick = onClick;
  return node;
}

async function save(action) {
  el("project-form-notice").textContent = "";
  try {
    await action();
    projects = (await api(PROJECTS)).projects;
    render();
  } catch (error) {
    el("project-form-notice").textContent = error.message;
  }
}
const send = (path, method, body) =>
  api(path, { method, body: JSON.stringify(body) });

function move(index, offset) {
  const ids = projects.map((project) => project.id);
  const target = index + offset;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  void save(() => send(`${PROJECTS}/order`, "PUT", { ids }));
}

function edit(project) {
  editing = project;
  el("project-name").value = project?.name ?? "";
  for (const box of el("project-repositories").querySelectorAll("input"))
    box.checked = Boolean(project?.repositories.includes(box.value));
  el("project-save").textContent = project ? "Save project" : "Create project";
  el("project-cancel").hidden = !project;
}

function render() {
  el("project-list").replaceChildren(
    ...projects.map((project, index) => {
      const item = text("li", "", "project-item");
      const summary = text("div");
      summary.append(
        text("strong", project.name),
        text(
          "small",
          project.repositories.join(", ") || "No repositories",
          "project-repo-list",
        ),
      );
      item.append(
        summary,
        button("↑", () => move(index, -1), `Move ${project.name} up`),
        button("↓", () => move(index, 1), `Move ${project.name} down`),
        button("Edit", () => edit(project), `Edit ${project.name}`),
        button(
          "Delete",
          () =>
            void save(() =>
              send(`${PROJECTS}/${project.id}`, "DELETE", {
                revision: project.revision,
              }),
            ),
          `Delete ${project.name}`,
        ),
      );
      return item;
    }),
  );
  el("project-list-empty").hidden = projects.length > 0;
  el("project-list-empty").textContent =
    "No projects yet. Name one and choose its repositories.";
  edit(null);
}

function submit(event) {
  event.preventDefault();
  const body = {
    name: el("project-name").value,
    repositories: [
      ...el("project-repositories").querySelectorAll("input:checked"),
    ].map((box) => box.value),
  };
  void save(() =>
    editing
      ? send(`${PROJECTS}/${editing.id}`, "PUT", {
          ...body,
          revision: editing.revision,
        })
      : send(PROJECTS, "POST", body),
  );
}

/** Render the Projects section from the page bootstrap's projects. */
export function initProjectSettings(page) {
  editing = null;
  canEdit = Boolean(page.plugin.canEdit) && !demoMode;
  projects = page.foundry?.projects ?? [];
  const repositories = availableRepositories(page.plugin);
  el("project-repositories").replaceChildren(
    text("legend", "Repositories"),
    ...repositories.map((repo) => {
      const label = text("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = repo.name.toLowerCase();
      box.disabled = !canEdit;
      label.append(box, repo.name);
      return label;
    }),
  );
  el("project-form").hidden = !canEdit;
  el("project-form").onsubmit = submit;
  el("project-cancel").onclick = () => edit(null);
  render();
  if (!page.foundry)
    el("project-list-empty").textContent =
      "An organization administrator manages projects.";
}
