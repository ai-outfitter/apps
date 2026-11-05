// The conversation sidebar's browser adapter, shared by the platform shell and
// the Chat app: the selected entry after each navigation, refreshing the lists
// from a server-rendered partial, pinning, and the platform project dialog.
// Listeners delegate from `document` and are installed once per document.

export const SIDEBAR_REFRESH = "outfitter:sidebar-refresh";
export const PROJECT_SAVED = "outfitter:project-saved";

export type ChatSidebarOptions = {
  /** The server-rendered lists (`[data-sidebar-lists]`), or none on pages without them. */
  partialURL?: string;
  /** Pin or unpin a conversation; rejects with a message to show. */
  pin?(id: string, pinned: boolean): Promise<void>;
  /** Platform routes (the project APIs and the project page) as this page reaches them. */
  platformURL?(path: string): string;
  /** Where a new project opens when no island takes it. */
  projectURL?(id: string): string;
};

type Project = { id: string; name: string; instructions: string; repositories?: string[] };
type RepositoryOptions = { connected: boolean; repositories: { name: string; ready: boolean }[] };

const sidebar = () => document.getElementById("sidebar");

function text(tag: string, value: string, attributes: Record<string, string> = {}) {
  const element = document.createElement(tag);
  for (const [name, attribute] of Object.entries(attributes)) element.setAttribute(name, attribute);
  element.textContent = value;
  return element;
}

/** Marks the sidebar entry for the current page. */
export function markSelected() {
  const aside = sidebar();
  if (!aside) return;
  const path = location.pathname.replace(/\/$/, "") || "/";
  aside.querySelectorAll<HTMLAnchorElement>("a[data-chat-route]").forEach((link) => {
    const target = new URL(link.href).pathname.replace(/\/$/, "") || "/";
    const selected =
      link.dataset.chatRoute === "chat"
        ? target === path
        : link.dataset.chatRoute === "project"
          ? path === target || path.startsWith(`${target}/`)
          : false;
    link.classList.toggle("selected", selected);
  });
}

export function installChatSidebar(options: ChatSidebarOptions = {}) {
  const flag = window as Window & { __outfitterChatSidebar?: boolean };
  if (flag.__outfitterChatSidebar) return;
  flag.__outfitterChatSidebar = true;
  const platform = options.platformURL ?? ((path: string) => path);
  let refreshVersion = 0;
  let dialogBusy = false;
  let selectedRepositories: string[] = [];
  let repositoryOptions: Promise<RepositoryOptions> | null = null;

  async function refreshSidebar() {
    const lists = sidebar()?.querySelector<HTMLElement>("[data-sidebar-lists]");
    if (!lists || !options.partialURL) return;
    const version = ++refreshVersion;
    try {
      const response = await fetch(options.partialURL, { headers: { Accept: "text/html" } });
      if (!response.ok) throw new Error();
      const html = await response.text();
      // Our own server-rendered, escaped Astro partial for the signed-in account.
      if (version === refreshVersion) {
        lists.innerHTML = html;
        markSelected();
      }
    } catch {
      /* Keep the last rendered list; the next navigation or save retries. */
    }
  }

  function sidebarNotice(message: string) {
    const notice = sidebar()?.querySelector<HTMLElement>("[data-sidebar-notice]");
    if (!notice) return;
    notice.textContent = message;
    notice.hidden = !message;
  }

  async function togglePin(button: HTMLButtonElement) {
    if (!options.pin) return;
    const pins = [...document.querySelectorAll<HTMLButtonElement>("#sidebar .pin-chat")];
    for (const pin of pins) pin.disabled = true;
    sidebarNotice("");
    try {
      await options.pin(button.dataset.chatId || "", button.dataset.pinned !== "true");
      await refreshSidebar();
    } catch {
      sidebarNotice("Could not update this pin. Please try again.");
    } finally {
      document.querySelectorAll<HTMLButtonElement>("#sidebar .pin-chat").forEach((pin) => {
        pin.disabled = false;
      });
    }
  }

  async function request<T>(path: string) {
    const response = await fetch(platform(path), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error((await response.text()) || "The request could not be completed.");
    return (await response.json()) as T;
  }

  function renderRepositories(dialog: HTMLDialogElement) {
    const list = dialog.querySelector<HTMLElement>("[data-project-repository-list]");
    if (!list) return;
    list.replaceChildren(...selectedRepositories.map((name) => {
      const item = text("li", name);
      const remove = text("button", "Remove", { type: "button", class: "text-button", "aria-label": `Remove ${name}` });
      remove.addEventListener("click", () => {
        selectedRepositories = selectedRepositories.filter((selected) => selected !== name);
        renderRepositories(dialog);
      });
      item.appendChild(remove);
      return item;
    }));
    void fillRepositoryPicker(dialog);
  }

  /** The picker's first, empty option. */
  function pickerPrompt(connected: boolean, ready: number, listed: number) {
    if (!connected) return "GitHub is not connected";
    if (ready) return "Choose a repository";
    return listed ? "None have write access yet" : "No more repositories";
  }

  async function fillRepositoryPicker(dialog: HTMLDialogElement) {
    const picker = dialog.querySelector("[data-project-repository-picker]") as HTMLSelectElement | null;
    if (!picker) return;
    repositoryOptions ??= request<RepositoryOptions>("/api/projects/repositories");
    let available: RepositoryOptions;
    try {
      available = await repositoryOptions;
    } catch {
      repositoryOptions = null;
      picker.replaceChildren(new Option("Could not load your GitHub repositories", ""));
      picker.disabled = true;
      return;
    }
    const choices = available.repositories.filter((repo) => !selectedRepositories.includes(repo.name));
    // A repository the agent could not work in is listed, but cannot be chosen.
    const ready = choices.filter((repo) => repo.ready).length;
    picker.replaceChildren(
      new Option(pickerPrompt(available.connected, ready, choices.length), ""),
      ...choices.map((repo) => {
        const option = new Option(repo.ready ? repo.name : `${repo.name} (needs write access)`, repo.name);
        option.disabled = !repo.ready;
        return option;
      }),
    );
    picker.disabled = !ready;
  }

  function openProjectDialog(project: Project | null) {
    const dialog = document.getElementById("project-dialog") as HTMLDialogElement | null;
    const form = dialog?.querySelector("form");
    if (!dialog || !form || dialog.open) return;
    form.reset();
    dialog.dataset.projectId = project?.id || "";
    const title = dialog.querySelector("#project-dialog-title");
    if (title) title.textContent = project ? "Edit project" : "New project";
    (form.elements.namedItem("name") as HTMLInputElement).value = project?.name || "";
    (form.elements.namedItem("instructions") as HTMLTextAreaElement).value = project?.instructions || "";
    selectedRepositories = [...(project?.repositories ?? [])];
    renderRepositories(dialog);
    const error = dialog.querySelector<HTMLElement>("[data-project-error]");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    dialog.showModal();
  }

  function setDialogBusy(dialog: HTMLDialogElement, busy: boolean) {
    dialogBusy = busy;
    dialog.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = busy;
    });
    const submit = dialog.querySelector<HTMLButtonElement>("button.primary");
    if (submit) submit.textContent = busy ? "Saving…" : "Save project";
  }

  /** An edited project's new name and settings, wherever this page shows them. */
  function showSavedProject(project: Project) {
    document.querySelectorAll<HTMLElement>(`[data-project-title="${project.id}"]`).forEach((title) => {
      title.textContent = project.name;
    });
    document.querySelectorAll<HTMLElement>("[data-project-dialog][data-project]").forEach((button) => {
      if ((JSON.parse(button.dataset.project || "{}") as Project).id === project.id) button.dataset.project = JSON.stringify(project);
    });
  }

  /** A new project: the chat island opens its timeline; other pages navigate to it. */
  function openNewProject(project: Project) {
    const saved = new CustomEvent(PROJECT_SAVED, { cancelable: true, detail: project });
    document.dispatchEvent(saved);
    if (!saved.defaultPrevented) location.assign((options.projectURL ?? ((projectId) => `/p/${encodeURIComponent(projectId)}`))(project.id));
  }

  /** Create or update the project on the platform; rejects with the reason to show. */
  async function submitProject(id: string | undefined, data: FormData): Promise<Project> {
    const response = await fetch(platform(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects"), {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.get("name"), instructions: data.get("instructions"), repositories: selectedRepositories }),
    });
    // A refused save (e.g. a repository the agent could not work in, or GitHub
    // to reconnect) answers 4xx with why.
    if (!response.ok) throw new Error(response.status < 500 ? await response.text() : "");
    return response.json();
  }

  function showSaveError(dialog: HTMLDialogElement, failure: unknown) {
    const error = dialog.querySelector<HTMLElement>("[data-project-error]");
    if (!error) return;
    error.textContent = (failure instanceof Error && failure.message) || "Could not save this project. Please try again.";
    error.hidden = false;
  }

  async function saveProject(dialog: HTMLDialogElement, form: HTMLFormElement) {
    const id = dialog.dataset.projectId;
    const error = dialog.querySelector<HTMLElement>("[data-project-error]");
    setDialogBusy(dialog, true);
    if (error) error.hidden = true;
    try {
      const project = await submitProject(id, new FormData(form));
      setDialogBusy(dialog, false);
      dialog.close();
      void refreshSidebar();
      if (id) showSavedProject(project);
      else openNewProject(project);
    } catch (failure) {
      setDialogBusy(dialog, false);
      showSaveError(dialog, failure);
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const pin = target?.closest<HTMLButtonElement>("#sidebar .pin-chat");
    if (pin) return void togglePin(pin);
    const projectButton = target?.closest<HTMLElement>("[data-project-dialog]");
    if (projectButton) return openProjectDialog(projectButton.dataset.project ? JSON.parse(projectButton.dataset.project) : null);
    if (target?.closest("#project-dialog [data-project-cancel]") && !dialogBusy)
      (document.getElementById("project-dialog") as HTMLDialogElement | null)?.close();
  });
  document.addEventListener("change", (event) => {
    const picker = (event.target as Element | null)?.closest("#project-dialog [data-project-repository-picker]") as HTMLSelectElement | null;
    if (!picker?.value || dialogBusy || selectedRepositories.includes(picker.value)) return;
    selectedRepositories = [...selectedRepositories, picker.value];
    renderRepositories(picker.closest("dialog") as HTMLDialogElement);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    const dialog = form.closest<HTMLDialogElement>("#project-dialog");
    if (!dialog) return;
    event.preventDefault();
    if (!dialogBusy) void saveProject(dialog, form);
  });
  document.addEventListener("cancel", (event) => {
    if ((event.target as Element).id === "project-dialog" && dialogBusy) event.preventDefault();
  }, true);
  document.addEventListener(SIDEBAR_REFRESH, () => void refreshSidebar());
  document.addEventListener("astro:after-swap", markSelected);
  markSelected();
}
