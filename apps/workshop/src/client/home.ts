import { onPageLoad } from "@ai-outfitter/ui/page";
import { PHASES, type Phase, type Project, ProjectSchema } from "../lib/project";
import { appBase, projectPath, projectSlug, type SectionId } from "../lib/sections";
import { fixtureRequest } from "./fixtures";
import { createThumbnailer } from "./thumbnails";

// A build-time constant, so the demo bundle carries no API calls.
const readOnly = import.meta.env.OUTFITTER_APP_MODE === "demo";
type Summary = Pick<Project, "id" | "name" | "revision" | "updatedAt" | "phase">;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => {
  const node = document.querySelector<T>(s);
  if (!node) throw new Error(`Missing element: ${s}`);
  return node;
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (readOnly) return fixtureRequest<T>(path, method);
  const res = await fetch(`/api/apps/workshop/projects${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The stages as a hairline track, with the project's stage marked and the ones before it done. */
function phaseTrack(phase: Phase) {
  const track = document.createElement("ol");
  track.className = "phase-track";
  const at = PHASES.findIndex((p) => p.id === phase);
  PHASES.forEach((p, index) => {
    const step = document.createElement("li");
    step.textContent = p.label;
    step.className = index < at ? "phase-step done" : "phase-step";
    if (index === at) {
      step.className = "phase-step current";
      step.setAttribute("aria-current", "step");
    }
    track.append(step);
  });
  track.setAttribute("aria-label", `Stage: ${PHASES[at]?.label ?? "Concept"}`);
  return track;
}

function projectRow(p: Summary, base: string) {
  const row = document.createElement("li");
  row.className = "project-row";
  row.dataset.project = p.id;
  const link = document.createElement("a");
  link.href = `${base}${projectPath(projectSlug(p))}`;
  const thumb = document.createElement("canvas");
  thumb.className = "thumb";
  thumb.setAttribute("aria-hidden", "true");
  const name = document.createElement("strong");
  name.textContent = p.name;
  const meta = document.createElement("small");
  meta.textContent = `Revision ${p.revision} · updated ${date(p.updatedAt)}`;
  const text = document.createElement("span");
  text.className = "project-text";
  text.append(name, meta);
  link.append(thumb, text);
  row.append(link, phaseTrack(p.phase));
  return row;
}

onPageLoad((signal) => {
  if (!document.querySelector(".workshop-home")) return;
  const base = appBase(location.pathname);
  const notice = (message = "") => {
    $("#notice").textContent = message;
    $("#notice").hidden = !message;
  };
  const open = (p: Pick<Project, "id" | "name">, section: SectionId = "overview") => {
    // A link, so the client router swaps the page in place.
    const link = document.createElement("a");
    link.href = `${base}${projectPath(projectSlug(p), section)}`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  };

  let thumbnails: ReturnType<typeof createThumbnailer> | undefined;
  const observer = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const row = entry.target as HTMLElement;
      try {
        const project = await api<Project>(`/${row.dataset.project}`);
        thumbnails ??= createThumbnailer();
        const canvas = row.querySelector("canvas");
        if (!canvas || signal.aborted) return;
        await thumbnails.render(project, canvas);
        row.dataset.thumbnail = "ready";
      } catch {
        // A project the CAD engine cannot build keeps an empty picture.
        row.dataset.thumbnail = "failed";
      }
    }
  });
  signal.addEventListener("abort", () => {
    observer.disconnect();
    thumbnails?.dispose();
  });

  async function load() {
    const list = $("#project-list");
    try {
      const projects = await api<Summary[]>("");
      if (signal.aborted) return;
      // Most recently changed first.
      const rows = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => projectRow({ ...p, phase: p.phase ?? "concept" }, base));
      list.replaceChildren(...rows);
      $("#projects-empty").hidden = rows.length > 0;
      for (const row of rows) observer.observe(row);
    } catch (e) {
      notice((e as Error).message);
    } finally {
      list.removeAttribute("aria-busy");
    }
  }
  void load();

  if (readOnly) {
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(".workshop-home button, .workshop-home textarea")) control.disabled = true;
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
      open(ProjectSchema.parse((await response.json()).project), "design");
    } catch (e) {
      status.textContent = "The design request did not complete. Your message is still here to retry.";
      notice((e as Error).message);
    } finally {
      busy = false;
    }
  });
});
