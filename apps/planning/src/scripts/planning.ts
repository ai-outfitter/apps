// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.

import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import {
  type OrganizationMember,
  organizationMembers,
} from "@ai-outfitter/app-sdk/members";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { intakeFocus } from "../agent-focus";
import { CARD_PROJECTS, type GoalProgress, type Light, lightOf, organizationCards, statusLabel } from "../project-cards";
import type { ProjectReadiness } from "../project-readiness";
import type { PageIssue as Issue, PageProject as Project, ProjectPage } from "../server/project-page";
import { readinessRules, readinessSummary } from "./readiness-view";

function append(parent: Node, ...children: (Node | string)[]) {
  for (const child of children)
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
}
onPageLoad((signal) => {
  // The use-cases page shares the "planning" id.
  const root = document.querySelector<HTMLElement>("#planning[data-project-workspace]");
  if (!root) return;
  const page = agentPage("planning");
  // The chat outlives the page; what this page selected does not.
  signal.addEventListener("abort", () => page.set({ focus: null }));
  const projectId = root.dataset.projectId || "";
  const basePath = location.pathname
    .replace(/\/projects(?:\/[^/]+)?\/?$/, "")
    .replace(/\/$/, "");
  const projectHref = (id: string) =>
    `${basePath}/projects/${encodeURIComponent(id)}`;
  const demo = import.meta.env.OUTFITTER_APP_MODE === "demo";
  if (projectId) {
    const intro = document.querySelector<HTMLElement>(".intro");
    const back = root.querySelector<HTMLElement>("#project-back");
    if (intro && back) {
      intro.querySelector("p")?.remove();
      intro.insertBefore(back, intro.firstChild);
    }
  }
  const get = <T = HTMLDivElement>(id: string) =>
    root.querySelector(`#${id}`) as T;
  const notice = get<HTMLParagraphElement>("planning-notice"),
    projectEditor = get<HTMLFormElement>("project-editor"),
    issueEditor = get<HTMLFormElement>("issue-editor");
  let directoryAvailable = false;
  let readiness = new Map<string, ProjectReadiness>();
  let readinessRequest = 0;
  const bootstrap = document.getElementById("project-page-data");
  const goalsData = document.getElementById("organization-goals-data");
  let organizationGoals: NonNullable<ProjectPage["organizationGoals"]> = goalsData ? JSON.parse(goalsData.textContent || "{}") : {};
  const initial = bootstrap ? JSON.parse(bootstrap.textContent || "{}") as Pick<ProjectPage, "projects" | "issues"> : null;
  let projects: Project[] = initial?.projects ?? [],
    issues: Issue[] = initial?.issues ?? [],
    members: OrganizationMember[] = [];
  const docs = [
    ["goals", "Goals"],
    ["userStories", "User stories"],
    ["pressRelease", "Draft press release"],
    ["demoInstructions", "Demo instructions"],
    ["demoResults", "Demo results"],
  ] as const;
  const project = () => projects.find((p) => p.id === projectId);
  const elem = (tag: string, text = "", className = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const field = (form: HTMLFormElement, name: string) =>
    form.elements.namedItem(name) as
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const api = async <T = unknown>(
    path = "",
    method = "GET",
    body?: unknown,
  ) => {
    if (demo) throw new Error("Read-only demo");
    const response = await fetch(`/api/apps/planning${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as T;
  };
  const run = async (work: () => Promise<void>, showSaved = true) => {
    notice.hidden = false;
    notice.textContent = "Saving…";
    try {
      await work();
      notice.textContent = showSaved ? (demo ? "Read-only demo" : "Saved") : "";
      notice.hidden = !notice.textContent;
    } catch (error) {
      notice.textContent =
        error instanceof Error ? error.message : "Unable to save";
    }
  };
  const button = (text: string, action: () => Promise<void> | void) => {
    const b = elem(
      "button",
      text,
      "ui-button ui-button--secondary",
    ) as HTMLButtonElement;
    b.type = "button";
    b.disabled = demo;
    b.onclick = () =>
      void run(async () => {
        await action();
      });
    return b;
  };
  const options = (
    select: HTMLSelectElement,
    values: OrganizationMember[],
    empty: string,
  ) => {
    select.replaceChildren(
      new Option(empty, ""),
      ...values.map((v) => new Option(v.name, v.id)),
    );
  };
  function publish(
    claim: import("@ai-outfitter/app-sdk/agent-context").PageClaim,
  ) {
    page.set({
      ...claim,
      fieldOptions: {
        assigneeId: [
          { value: null, label: "Unassigned" },
          ...members.map((m) => ({ value: m.id, label: m.name })),
        ],
        parentId: [
          { value: null, label: "No parent" },
          ...issues
            .filter(
              (i) => i.projectId === project()?.id && i.id !== claim.focus?.id,
            )
            .map((i) => ({ value: i.id, label: i.title })),
        ],
      },
    });
  }
  function focusProject(p: Project | undefined) {
    publish({
      focus: p
        ? {
            kind: "planning-project",
            id: p.id,
            label: p.name,
            revision: p.revision,
          }
        : intakeFocus,
    });
  }
  function goalRow(row: GoalProgress) {
    const line = elem("div", "", "planning-goal-row");
    const name = elem("div", row.goal.title, "planning-goal-name");
    const bar = elem("div", "", "planning-goal-bar");
    bar.title = `${row.green} ready · ${row.yellow} decisions · ${row.none} unassessed`;
    if (!row.total) append(bar, elem("span", "none", "planning-goal-empty"));
    for (const value of ["green", "yellow", "none"] as const) {
      if (!row[value]) continue;
      const segment = elem("span", String(row[value]), "planning-goal-segment");
      segment.dataset.light = value;
      segment.style.flex = String(row[value]);
      append(bar, segment);
    }
    append(line, name, bar);
    return line;
  }
  function projectLine(item: Project, index: number) {
    const value: Light = lightOf(item);
    const decisions = item.readiness?.missing ?? [];
    const entry = elem("li", "", "planning-org-more");
    entry.hidden = index >= CARD_PROJECTS;
    entry.dataset.orderRow = item.id;
    const row = elem("div", "", "planning-org-project");
    const link = document.createElement("a");
    link.href = item.href ?? projectHref(item.id);
    link.className = "planning-org-project-name";
    link.textContent = item.name;
    const status = elem(decisions.length ? "button" : "span", statusLabel(item), "planning-status");
    status.dataset.light = value;
    append(row, link);
    if (root?.dataset.canOrder === "true") {
      const handle = elem("button", "⠿", "planning-drag-handle");
      handle.setAttribute("type", "button"); handle.setAttribute("draggable", "true");
      handle.setAttribute("aria-label", `Reorder ${item.name}`); handle.title = "Drag to reorder; use arrow keys to move";
      handle.dataset.dragId = item.id; append(row, handle);
    }
    if (item.state) append(row, elem("span", item.state, "planning-project-state"));
    append(row, status);
    append(entry, row);
    if (decisions.length) {
      const list = elem("ul", "", "planning-decisions");
      list.id = `decisions-${item.id}`;
      list.hidden = true;
      for (const need of decisions) append(list, elem("li", need));
      status.setAttribute("type", "button");
      status.setAttribute("aria-expanded", "false");
      status.setAttribute("aria-controls", list.id);
      append(entry, list);
    }
    return entry;
  }
  // One card per organization (the member's own projects first): its goals' progress, then its projects with their lights.
  function renderProjectCards(cards: HTMLElement) {
    if (projectId || !projects.length) return;
    cards.classList.remove("planning-card-grid");
    for (const card of organizationCards(projects, organizationGoals)) {
      const section = elem("section", "", "planning-org-card");
      section.setAttribute("aria-label", card.label);
      const header = elem("header", "", "planning-org-card-header");
      append(header, elem("h2", card.label));
      append(section, header);
      if (card.goals.length) {
        const chart = elem("div", "", "planning-goal-chart");
        chart.setAttribute("role", "group");
        chart.setAttribute("aria-label", `${card.label} goals`);
        for (const row of card.goals) append(chart, goalRow(row));
        append(section, chart);
      }
      const list = elem("ul", "", "planning-org-projects");
      for (const [index, item] of card.projects.entries()) append(list, projectLine(item, index));
      append(section, list);
      const hidden = card.projects.length - CARD_PROJECTS;
      if (hidden > 0) {
        const toggle = elem("button", `${hidden} more`, "planning-org-toggle");
        toggle.setAttribute("type", "button");
        toggle.dataset.more = `${hidden} more`;
        toggle.dataset.fewer = "Fewer";
        append(section, toggle);
      }
      append(cards, section);
    }
  }
  async function loadReadiness() {
    if (demo) return;
    const request = ++readinessRequest;
    try {
      const response = await api<{ projects: ProjectReadiness[] }>("/readiness");
      if (request !== readinessRequest) return;
      readiness = new Map(response.projects.map(item => [item.projectId, item]));
    } catch {
      if (request !== readinessRequest) return;
      readiness.clear();
    }
    render();
  }
  function render() {
    const cards = get("project-cards");
    cards.replaceChildren();
    renderProjectCards(cards);
    const p = projectId ? project() : undefined;
    publishEditor();
    get("empty").hidden = projects.length > 0;
    get("project-detail").hidden = !p;
    get("project-issues").hidden = !p;
    if (!p) {
      if (projectId) {
        get("empty").hidden = false;
        get("empty").textContent =
          "Project not found. Return to All projects to choose another project.";
      }
      return;
    }
    document.title = `${p.name} — Planning`;
    const heading = document.querySelector(".intro h1");
    if (heading) {
      heading.textContent = p.name;
      heading.id = "project-name";
    }
    const assessment = get("project-readiness");
    assessment.hidden = false;
    assessment.replaceChildren(readinessSummary(readiness.get(p.id)), readinessRules());
    renderDocuments(p);
    const list = get("issue-list");
    list.replaceChildren();
    const projectIssues = issues.filter((i) => i.projectId === p.id),
      showDone = get<HTMLInputElement>("show-completed").checked;
    for (const [category, heading] of [
      ["stone", "Stones"],
      ["pebble", "Pebbles"],
      ["sand", "Sand"],
    ]) {
      append(list, elem("h3", heading));
      const categoryIssues = projectIssues.filter(
        (i) => i.category === category,
      );
      const visible = categoryIssues.filter(
        (i) => showDone || i.status !== "done",
      );
      if (!visible.length)
        append(list, elem("p", "No issues in this view.", "muted"));
      for (const issue of visible)
        renderIssue(issue, categoryIssues, projectIssues, p, list, category);
    }
  }
  function renderDocuments(p: Project) {
    const container = get("project-documents");
    // The server renders the body from the Wiki (and Markdown); saving the project reloads the page.
    if (container.hasAttribute("data-server-rendered")) return;
    container.replaceChildren();
    for (const [key, label] of docs) {
      if (!p[key]) continue;
      const article = elem("article");
      append(article, elem("h2", label), elem("p", p[key]));
      append(container, article);
    }
    if (p.githubRepository) {
      const link = document.createElement("a");
      link.href = p.githubRepository;
      link.textContent = p.githubRepository;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const repository = elem("article");
      append(repository, elem("h2", "GitHub repository"), link);
      append(container, repository);
    }
  }
  function renderIssue(
    issue: Issue,
    categoryIssues: Issue[],
    projectIssues: Issue[],
    p: Project,
    list: HTMLDivElement,
    category: string,
  ) {
    const card = elem("article", "", "planning-issue");
    append(card, elem("h4", issue.title));
    const parent = projectIssues.find((i) => i.id === issue.parentId);
    append(
      card,
      elem(
        "small",
        [
          issue.status,
          issue.dueDate,
          issue.assigneeId
            ? (members.find((m) => m.id === issue.assigneeId)?.name ??
              (directoryAvailable ? "Former member" : "Assigned member"))
            : null,
          parent ? `Sub-issue of ${parent.title}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    if (issue.description) append(card, elem("p", issue.description));
    const actions = elem("div", "", "planning-toolbar");
    append(
      actions,
      button("Edit", () => editIssue(issue)),
      button(issue.status === "done" ? "Reopen" : "Complete", async () => {
        await api(`/issues/${issue.id}`, "PUT", {
          ...editableIssue(issue),
          revision: issue.revision,
          status: issue.status === "done" ? "todo" : "done",
        });
        await load();
      }),
      button("Delete", async () => {
        if (confirm(`Delete ${issue.title}? Reassign its sub-issues first.`)) {
          await api(`/issues/${issue.id}`, "DELETE", {
            revision: issue.revision,
          });
          await load();
        }
      }),
    );
    for (const [title, delta] of [
      ["Move up", -1],
      ["Move down", 1],
    ] as const) {
      const index = categoryIssues.indexOf(issue),
        next = index + delta;
      const b = button(title, async () => {
        const ordered = [...categoryIssues];
        [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
        await api("/issues/reorder", "POST", {
          projectId: p.id,
          category,
          items: ordered.map((i) => ({ id: i.id, revision: i.revision })),
        });
        await load();
      });
      if (next < 0 || next >= categoryIssues.length) b.disabled = true;
      append(actions, b);
    }
    append(card, actions);
    append(list, card);
  }
  const editableIssue = (i: Issue) => ({
    projectId: i.projectId,
    title: i.title,
    description: i.description,
    category: i.category,
    status: i.status,
    assigneeId: i.assigneeId,
    dueDate: i.dueDate,
    parentId: i.parentId,
  });
  function editProject(p?: Project) {
    projectEditor.reset();
    projectEditor.dataset.id = p?.id ?? "";
    projectEditor.dataset.revision = String(p?.revision ?? 0);
    for (const key of ["name", "githubRepository", ...docs.map((d) => d[0])])
      field(projectEditor, key).value =
        p?.[key as keyof Project]?.toString() ?? "";
    projectEditor.hidden = false;
    field(projectEditor, "name").focus();
    publishEditor();
  }
  async function loadIssueEditorDirectory() {
    if (!demo) {
      try { members = await organizationMembers(); directoryAvailable = true; }
      catch { members = []; directoryAvailable = false; }
      const warning = get<HTMLParagraphElement>("directory-notice");
      warning.hidden = directoryAvailable;
      warning.textContent = directoryAvailable ? "" : "Member directory unavailable. Existing assignments are preserved; retry before assigning work.";
    }
  }
  async function editIssue(i?: Issue) {
    await loadIssueEditorDirectory();
    issueEditor.reset();
    issueEditor.dataset.id = i?.id ?? "";
    issueEditor.dataset.revision = String(i?.revision ?? 0);
    options(
      field(issueEditor, "parentId") as HTMLSelectElement,
      issues
        .filter((x) => x.projectId === project()?.id && x.id !== i?.id)
        .map((x) => ({ id: x.id, name: x.title })),
      "No parent",
    );
    const assignee = field(issueEditor, "assigneeId") as HTMLSelectElement;
    options(assignee, members, "Unassigned");
    // Keep a departed assignee visible so editing other fields does not clear it.
    if (i?.assigneeId && !members.some((m) => m.id === i.assigneeId))
      assignee.add(
        new Option(
          directoryAvailable ? "Former member" : "Assigned member",
          i.assigneeId,
        ),
      );
    if (i)
      for (const [key, value] of Object.entries(editableIssue(i)))
        if (issueEditor.elements.namedItem(key))
          field(issueEditor, key).value = value ?? "";
    issueEditor.hidden = false;
    field(issueEditor, "title").focus();
    publishEditor();
  }
  function publishEditor() {
    const p = project();
    if (!p) {
      focusProject(undefined);
      return;
    }
    const form = !issueEditor.hidden
      ? issueEditor
      : !projectEditor.hidden
        ? projectEditor
        : null;
    if (!form) {
      focusProject(p);
      return;
    }
    const issue =
      form === issueEditor
        ? issues.find((i) => i.id === form.dataset.id)
        : undefined;
    if (!form.dataset.id) {
      focusProject(p);
      return;
    }
    const draft = Object.fromEntries(new FormData(form));
    for (const key of ["parentId", "assigneeId", "dueDate"])
      if (key in draft && !draft[key]) draft[key] = null as unknown as string;
    delete draft.revision;
    delete draft.projectId;
    publish({
      focus: issue
        ? {
            kind: "planning-issue",
            id: issue.id,
            label: issue.title,
            revision: Number(form.dataset.revision),
            project: { id: p.id, label: p.name },
          }
        : {
            kind: "planning-project",
            id: p.id,
            label: p.name,
            revision: Number(form.dataset.revision),
          },
      draft,
    });
  }
  projectEditor.addEventListener("input", publishEditor);
  issueEditor.addEventListener("input", publishEditor);
  signal.addEventListener("abort", page.onApplied(() => void run(async () => {
    await load();
    // Project documents are rendered from Wiki context and Markdown on the
    // server. Refresh that fragment after an approved change, without losing
    // the open editor or the conversation.
    // Demo pages have no approved changes to refresh.
    if (import.meta.env.OUTFITTER_APP_MODE === "demo" || !projectId || signal.aborted) return;
    const response = await fetch(location.href, {signal});
    if (!response.ok) throw new Error("Saved changes, but project documents could not be refreshed.");
    const html = await response.text();
    if (signal.aborted) return;
    const refreshed = new DOMParser().parseFromString(html, "text/html").getElementById("project-documents");
    if (!refreshed) throw new Error("Saved changes, but project documents could not be refreshed.");
    get("project-documents").replaceChildren(...refreshed.childNodes);
  }, false)));
  async function load() {
    if (!demo) {
      const [data, directory] = await Promise.all([
        api<{ projects: Project[]; issues: Issue[]; organizationGoals?: ProjectPage["organizationGoals"] }>(projectId ? "" : "/projects"),
        organizationMembers().catch((error: unknown) => {
          if (
            !(error instanceof Error) ||
            !("status" in error) ||
            error.status !== 503
          )
            throw error;
          return null;
        }),
      ]);
      projects = data.projects;
      issues = data.issues;
      if (data.organizationGoals) organizationGoals = data.organizationGoals;
      members = directory ?? [];
      directoryAvailable = directory !== null;
      const warning = get<HTMLParagraphElement>("directory-notice");
      warning.hidden = directoryAvailable;
      warning.textContent = directoryAvailable
        ? ""
        : "Member directory unavailable. Existing assignments are preserved; retry before assigning work.";
    }
    render();
    void loadReadiness();
  }
  // The workspace renders on the projects list and on a project page; both share the app mount.
  const priorityUrl = `${location.pathname.replace(/\/projects(?:\/.*)?$/, "")}/api/apps/planning/priority-order`;
  const prioritySnapshot = import.meta.env.OUTFITTER_APP_MODE !== "demo" && root?.dataset.canOrder === "true" ? fetch(`${priorityUrl}?kind=projects`).then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<{priorityOrder:{revision:number}}> }) : null;
  async function reorderProject(id:string, targetId:string) {
    if (import.meta.env.OUTFITTER_APP_MODE === "demo") return;
    const card=organizationCards(projects,organizationGoals).find(group=>group.projects.some(item=>item.id===id));
    if (!card || !prioritySnapshot) return;
    const items=card.projects.map(item=>item.id), from=items.indexOf(id), to=items.indexOf(targetId);
    if(from<0 || to<0 || from===to)return;
    items.splice(to,0,...items.splice(from,1));
    const {priorityOrder}=await prioritySnapshot;
    const saved=await fetch(priorityUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind:"projects",items,revision:priorityOrder.revision})});
    if(!saved.ok)throw new Error(await saved.text()); location.reload();
  }
  let draggedProject: string | null = null;
  const cardsRoot=get("project-cards");
  cardsRoot.addEventListener("dragstart", event=>{ const handle=(event.target as Element).closest<HTMLElement>("[data-drag-id]"); draggedProject=handle?.dataset.dragId ?? null; if(draggedProject) event.dataTransfer?.setData("text/plain",draggedProject); });
  cardsRoot.addEventListener("dragover",event=>{if(draggedProject && (event.target as Element).closest("[data-order-row]"))event.preventDefault();});
  cardsRoot.addEventListener("drop",event=>{const target=(event.target as Element).closest<HTMLElement>("[data-order-row]")?.dataset.orderRow; if(!draggedProject || !target)return; event.preventDefault(); const source=draggedProject; draggedProject=null; void reorderProject(source,target).catch(error=>{notice.hidden=false;notice.textContent=error.message;});});
  cardsRoot.addEventListener("dragend",()=>{draggedProject=null;});
  cardsRoot.addEventListener("keydown",event=>{const handle=(event.target as Element).closest<HTMLElement>("[data-drag-id]"); if(!handle || !["ArrowUp","ArrowDown"].includes(event.key))return; const id=handle.dataset.dragId ?? ""; const card=organizationCards(projects,organizationGoals).find(group=>group.projects.some(item=>item.id===id)); const index=card?.projects.findIndex(item=>item.id===id) ?? -1; const target=card?.projects[index+(event.key==="ArrowUp"?-1:1)]?.id; if(target){event.preventDefault();void reorderProject(id,target).catch(error=>{notice.hidden=false;notice.textContent=error.message;});}});
  // The status pill opens the project's decisions; "more" shows the rest of a card's projects.
  get("project-cards").addEventListener("click", event => {
    const target = event.target as Element;
    const status = target.closest<HTMLButtonElement>(".planning-status[aria-controls]");
    if (status) {
      const list = document.getElementById(status.getAttribute("aria-controls") ?? "");
      if (!list) return;
      list.hidden = !list.hidden;
      status.setAttribute("aria-expanded", String(!list.hidden));
      return;
    }
    const toggle = target.closest<HTMLButtonElement>(".planning-org-toggle");
    if (!toggle) return;
    const card = toggle.closest(".planning-org-card");
    const expanded = card?.toggleAttribute("data-expanded") ?? false;
    for (const [index, item] of (card?.querySelectorAll<HTMLElement>(".planning-org-more") ?? []).entries()) item.hidden = !expanded && index >= CARD_PROJECTS;
    toggle.textContent = expanded ? toggle.dataset.fewer ?? "" : toggle.dataset.more ?? "";
  });
  get("issue-list").addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-issue-action]");
    if (!button || button.disabled) return;
    const issue = issues.find(issue => issue.id === button.dataset.issueId);
    const p = project();
    if (!issue || !p) return;
    void run(async () => {
      switch (button.dataset.issueAction) {
        case "Edit": await editIssue(issue); return;
        case "Complete": await api(`/issues/${issue.id}`, "PUT", { ...editableIssue(issue), revision: issue.revision, status: "done" }); break;
        case "Delete": if (!confirm(`Delete ${issue.title}? Reassign its sub-issues first.`)) return; await api(`/issues/${issue.id}`, "DELETE", { revision: issue.revision }); break;
        case "Move up":
        case "Move down": {
          const ordered = issues.filter(item => item.projectId === p.id && item.category === issue.category);
          const index = ordered.indexOf(issue), next = index + (button.dataset.issueAction === "Move up" ? -1 : 1);
          if (next < 0 || next >= ordered.length) return;
          [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
          await api("/issues/reorder", "POST", { projectId: p.id, category: issue.category, items: ordered.map(item => ({ id: item.id, revision: item.revision })) }); break;
        }
        default: return;
      }
      await load();
    });
  });
  // New project and Reload sit beside the page title, outside the workspace root.
  const newProject = document.getElementById("new-project") as HTMLButtonElement | null;
  if (newProject) newProject.onclick = () => editProject();
  const edit = document.getElementById("edit-project"), newIssue = get("new-issue"), completed = get("show-completed");
  if (edit) edit.onclick = () => editProject(project());
  if (newIssue) newIssue.onclick = () => editIssue();
  if (completed) completed.onchange = () => render();
  const reload = document.getElementById("reload") as HTMLButtonElement | null;
  if (reload) reload.onclick = () =>
    void run(async () => {
      await load();
      for (const [form, rows] of [
        [projectEditor, projects],
        [issueEditor, issues],
      ] as const) {
        const row = rows.find((r) => r.id === form.dataset.id);
        if (row) form.dataset.revision = String(row.revision);
      }
    });
  const removeProject = document.getElementById("delete-project");
  if (removeProject) removeProject.onclick = () =>
    void run(async () => {
      const p = project();
      if (p && confirm(`Delete ${p.name}? Remove its issues first.`)) {
        await api(`/projects/${p.id}`, "DELETE", { revision: p.revision });
        location.assign(`${basePath}/projects`);
      }
    });
  root.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((b) => {
    b.onclick = () => {
      get(b.dataset.cancel!).hidden = true;
      publishEditor();
    };
  });
  projectEditor.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const id = projectEditor.dataset.id;
      const data = Object.fromEntries(new FormData(projectEditor));
      const saved = await api<Project>(
        id ? `/projects/${id}` : "/projects",
        id ? "PUT" : "POST",
        {
          ...data,
          ...(id ? { revision: Number(projectEditor.dataset.revision) } : {}),
        },
      );
      projectEditor.hidden = true;
      if (saved.id !== projectId) location.assign(projectHref(saved.id));
      else location.reload();
    });
  };
  issueEditor.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const id = issueEditor.dataset.id,
        data = Object.fromEntries(new FormData(issueEditor));
      await api(id ? `/issues/${id}` : "/issues", id ? "PUT" : "POST", {
        ...data,
        projectId: project()!.id,
        assigneeId: data.assigneeId || null,
        dueDate: data.dueDate || null,
        parentId: data.parentId || null,
        ...(id ? { revision: Number(issueEditor.dataset.revision) } : {}),
      });
      issueEditor.hidden = true;
      await load();
    });
  };
  const legacyProject = new URL(location.href).searchParams.get("project");
  if (!projectId && legacyProject) location.replace(projectHref(legacyProject));
  else if (initial) {
    if (projectId && project()) {
      const heading = document.querySelector(".intro h1");
      if (heading) heading.id = "project-name";
    }
    publishEditor();
  } else void run(load, !projectId);
});
