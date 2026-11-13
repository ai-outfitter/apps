import { onPageLoad } from "@ai-outfitter/ui/page";
import { type Project, ProjectSchema } from "../lib/project";
import { appBase, projectPath, projectSlug, type SectionId } from "../lib/sections";

// A build-time constant, so the demo bundle carries no API calls.
const readOnly = import.meta.env.OUTFITTER_APP_MODE === "demo";
type Summary = Pick<Project, "id" | "name" | "revision" | "updatedAt" | "phase">;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => {
  const node = document.querySelector<T>(s);
  if (!node) throw new Error(`Missing element: ${s}`);
  return node;
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (readOnly) return (await import("./fixtures")).fixtureRequest<T>(path, method);
  const res = await fetch(`/api/apps/workshop/projects${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function projectRow(p: Summary, base: string) {
  const row = document.createElement("li");
  row.className = "project-row";
  row.dataset.project = p.id;
  const link = document.createElement("a");
  link.href = `${base}${projectPath(projectSlug(p))}`;
  const name = document.createElement("strong");
  name.textContent = p.name;
  const text = document.createElement("span");
  text.className = "project-text";
  text.append(name);
  link.append(text);
  row.append(link);
  return row;
}

onPageLoad((signal) => {
  if (!document.querySelector(".workshop-home, .workshop-new-model")) return;
  const base = appBase(location.pathname.replace(/\/new\/?$/, ""));
  const newModelLink = document.querySelector<HTMLAnchorElement>("#new-model-link");
  if (newModelLink) newModelLink.href = `${base}/new`;
  const notice = (message = "") => {
    $("#notice").textContent = message;
    $("#notice").hidden = !message;
  };
  const open = (p: Pick<Project, "id" | "name">, section: SectionId = "assembly") => {
    // A link, so the client router swaps the page in place.
    const link = document.createElement("a");
    link.href = `${base}${projectPath(projectSlug(p), section)}`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  };

  if (document.querySelector("#project-list")) {
  async function load() {
    const list = $("#project-list");
    try {
      const projects = await api<Summary[]>("");
      if (signal.aborted) return;
      // Most recently changed first.
      const rows = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => projectRow({ ...p, phase: p.phase ?? "concept" }, base));
      list.replaceChildren(...rows);
      $("#projects-empty").hidden = rows.length > 0;

    } catch (e) {
      notice((e as Error).message);
    } finally {
      list.removeAttribute("aria-busy");
    }
  }
  void load();
  }

  if (!document.querySelector("#agent-form")) return;

  if (readOnly) {
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(".workshop-new-model button, .workshop-new-model textarea")) control.disabled = true;
    return;
  }

  let busy = false;
  document.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-example]");
    if (!button || busy) return;
    busy = true;
    try {
      open(await api<Project>("", "POST", { example: button.dataset.example }));
    } catch (e) {
      notice((e as Error).message);
    } finally {
      busy = false;
    }
  }, { signal });

  $("#agent-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $<HTMLTextAreaElement>("#agent-message").value.trim();
    if (!message || busy) return;
    busy = true;
    const status = $("#agent-status");
    status.textContent = "Creating model with Spark…";
    try {
      const response = await fetch("/api/apps/workshop/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      open(ProjectSchema.parse((await response.json()).project));
    } catch (e) {
      status.textContent = "The design request did not complete. Your message is still here to retry.";
      notice((e as Error).message);
    } finally {
      busy = false;
    }
  }, { signal });
});
