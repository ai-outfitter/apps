/// <reference types="w3c-web-serial" />
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.

import { onPageLoad } from "@ai-outfitter/ui/page";
import {
  designKey,
  electricalKey,
  fitReady,
  PHASES,
  pcbReady,
  productRevisionFrom,
  type Project,
  ProjectSchema,
} from "../lib/project";
import { appBase, projectPath, projectSlug, type SectionId, slugId } from "../lib/sections";
import { createAssemblyPanel } from "./assembly-panel";
import { fixtureRequest } from "./fixtures";
import { createViewer } from "./viewer";

const readOnly = import.meta.env.OUTFITTER_APP_MODE === "demo";
const $ = <T extends HTMLElement = HTMLElement>(s: string) => {
  const node = document.querySelector<T>(s);
  if (!node) throw new Error(`Missing element: ${s}`);
  return node;
};
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function sourceLink(url: string, label: string) {
  const a = element("a", label);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function removeButton(kind: string, id: string, name: string) {
  const b = element("button", "Remove", "remove");
  b.dataset.remove = kind;
  b.dataset.id = id;
  b.setAttribute("aria-label", `Remove ${name}`);
  return b;
}
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
type Research = Project["research"][number];
type Evidence = Project["evidence"][number];
type ProjectSummary = Pick<Project, "id" | "name" | "revision" | "updatedAt">;
let project: Project | undefined,
  dirty = false,
  saving = false,
  section: SectionId = "overview";
let geometryTimer: ReturnType<typeof setTimeout>;
let viewer: ReturnType<typeof createViewer> | undefined;
let assemblyPanel: ReturnType<typeof createAssemblyPanel> | undefined;
let serialLog = "",
  port: SerialPort | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
function notice(message = "") {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
function markDirty() {
  if (readOnly) return;
  dirty = true;
  $("#save-state").textContent = "Unsaved changes";
  $("#save").removeAttribute("disabled");
}
function loading(value: boolean) {
  saving = value;
  $(".shell").inert = value;
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (readOnly) return fixtureRequest<T>(path, method);
  const res = await fetch(`/api/apps/workshop/projects${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  const value = await res.json();
  return value as T;
}
/** Spark's answer while its revision is current, so it survives opening the design page. */
function agentStatus(p: Project | undefined) {
  if (!p) return "Spark makes a design study. Check dimensions and physical fit before fabrication.";
  const last = p.iterations.at(-1);
  return last?.revision === p.revision
    ? `Saved revision ${p.revision}. ${last.rationale || "Inspect the 3D preview and verify the measurements."}`
    : `Selected revision ${p.revision}. Describe a change to this model.`;
}
function updateAgentForm() {
  $("#agent-title").textContent = project
    ? `Change ${project.name}`
    : "Describe a model";
  $("#agent-submit").textContent = project ? "Update model" : "Create model";
  $<HTMLTextAreaElement>("#agent-message").placeholder = project
    ? "Increase each side by 10 mm"
    : "Make a solid cube 40 mm on each side";
  $("#agent-status").textContent = agentStatus(project);
  const history = $("#agent-history");
  history.replaceChildren(
    ...(project?.iterations
      .slice(-5)
      .map((item) =>
        element("li", `Revision ${item.revision}: ${item.prompt}`),
      ) ?? []),
  );
  history.hidden = !history.childElementCount;
}
async function save() {
  if (readOnly) return false;
  if (!project || saving) return false;
  try {
    const parsed = ProjectSchema.safeParse(project);
    if (!parsed.success)
      throw new Error(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    saving = true;
    $("#workspace").inert = true;
    $("#save").setAttribute("disabled", "");
    $("#save-state").textContent = "Saving…";
    const saved: Project = await api(`/${project.id}`, "PUT", project);
    project = saved;
    dirty = false;
    showTitle(saved);
    $("#save-state").textContent = `Saved · revision ${saved.revision}`;
    renderRecords();
    notice();
    return true;
  } catch (e) {
    notice((e as Error).message);
    return false;
  } finally {
    saving = false;
    $("#workspace").inert = false;
    if (dirty) $("#save").removeAttribute("disabled");
  }
}
function formValues(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form)) as Record<string, string>;
}
function bindForm(
  id: string,
  action: (data: Record<string, string>, draft: Project) => void,
) {
  const form = $<HTMLFormElement>(id);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!project || saving) return;
    const previous = structuredClone(project),
      wasDirty = dirty;
    try {
      const draft = structuredClone(previous);
      project = draft;
      action(formValues(form), draft);
      markDirty();
      if (await save()) form.reset();
      else {
        project = previous;
        dirty = wasDirty;
        renderRecords();
      }
    } catch (error) {
      project = previous;
      dirty = wasDirty;
      notice((error as Error).message);
    }
    if (!dirty) {
      $("#save").setAttribute("disabled", "");
      $("#save-state").textContent = `Saved · revision ${project.revision}`;
    }
  });
}
/** Opens another section's page through a link, so the client router swaps it
 * in place; the selected project carries over. */
function goTo(name: SectionId) {
  if (!project) return;
  const link = document.createElement("a");
  link.href = `${appBase(location.pathname)}${projectPath(projectSlug(project), name)}`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
/** Draws what this page's section needs once a project is selected. */
function showSection() {
  if (section === "design" && project) renderGeometry();
  if (section === "assembly" && project) {
    assemblyPanel ??= createAssemblyPanel(notice);
    void assemblyPanel.show(project);
  }
}
function renderGeometry() {
  if (!project) return;
  try {
    if (!viewer)
      viewer = createViewer(
        $<HTMLCanvasElement>("#viewer"),
        (message, checks, valid) => {
          $("#geometry-status").textContent = message;
          $("#geometry-checks").replaceChildren(
            ...checks.map((x) => element("div", `✓ ${x}`)),
          );
          $<HTMLButtonElement>("#step").disabled = !valid;
          $<HTMLButtonElement>("#stl").disabled = !valid;
        },
      );
    viewer.render({ ...project.params }, project.cadPlan);
  } catch (e) {
    $("#geometry-status").textContent = (e as Error).message;
    notice(
      "3D preview is unavailable in this browser. Project editing and project-package export are still available.",
    );
  }
}
function renderRecords() {
  if (!project) return;
  const p = project;
  $("#circuit-card").hidden = p.kind !== "electronics";
  $("#summary").replaceChildren(
    ...[
      ["Research candidates", p.research.length],
      ["Parts recorded", p.parts.length],
      ["Physical fit", fitReady(p) ? "Pass recorded" : "Needs a test"],
      ["Observations", p.evidence.length],
    ].map(([label, value]) => {
      const row = element("div", "", "summary-row");
      row.append(element("span", String(label)), element("b", String(value)));
      return row;
    }),
  );
  $("#next-title").textContent = p.research.length
    ? "Measure before you commit"
    : "Find what already exists";
  $("#next-body").textContent = p.research.length
    ? "Record the dimensions that matter, where they came from, and what still needs a physical check."
    : "A ready-made product or an open design might solve most of the problem. Start with a few candidates.";
  $("#next-action").textContent = p.research.length
    ? "Open the workbench →"
    : "Open research →";
  $("#research-list").replaceChildren(
    ...(p.research.length
      ? p.research.map((c) => {
          const card = element("article", "", "card"),
            head = element("div", "", "candidate-head");
          head.append(
            element("h3", c.name),
            removeButton("research", c.id, c.name),
          );
          card.append(
            head,
            element("div", `${c.kind} · ${c.decision}`, "candidate-meta"),
            element("p", c.notes, "candidate-note"),
          );
          if (c.url) card.append(sourceLink(c.url, "Open source ↗"));
          return card;
        })
      : [
          element(
            "div",
            "No candidates yet. Start with one useful find.",
            "empty",
          ),
        ]),
  );
  $("#parts-list").replaceChildren(
    ...(p.parts.length
      ? p.parts.map((c) => {
          const row = element("tr"),
            name = element("td");
          name.append(
            c.source
              ? sourceLink(c.source, `${c.name} ↗`)
              : document.createTextNode(c.name),
            element("small", c.notes),
          );
          const action = element("td");
          action.append(removeButton("parts", c.id, c.name));
          row.append(
            name,
            element("td", String(c.quantity)),
            element("td", money(c.unitCost)),
            element("td", money(c.quantity * c.unitCost)),
            action,
          );
          return row;
        })
      : [
          (() => {
            const row = element("tr"),
              cell = element("td", "No parts recorded yet.");
            cell.colSpan = 5;
            row.append(cell);
            return row;
          })(),
        ]),
  );
  $("#parts-total").textContent = money(
    p.parts.reduce((n, c) => n + c.quantity * c.unitCost, 0),
  );
  $("#evidence-list").replaceChildren(
    ...(p.evidence.length
      ? [...p.evidence].reverse().map((e) => {
          const card = element("article", "", "card"),
            head = element("div", "", "candidate-head");
          head.append(
            element("h3", e.stage),
            element("span", e.outcome, `outcome ${e.outcome}`),
          );
          card.append(
            head,
            element(
              "div",
              `${e.operator} · ${new Date(e.at).toLocaleString()}`,
              "candidate-meta",
            ),
            element("p", e.note, "candidate-note"),
          );
          if (e.stage === "Fit test" && e.designKey !== designKey(p))
            card.append(
              element(
                "p",
                "Earlier dimensions — repeat the fit test for this design.",
                "muted",
              ),
            );
          if (e.serialLog) {
            const details = element("details");
            details.append(
              element("summary", "Attached serial log"),
              element("pre", e.serialLog),
            );
            card.append(details);
          }
          card.append(removeButton("evidence", e.id, "observation"));
          return card;
        })
      : [
          element(
            "div",
            "No observed results yet. Record what happens on your bench.",
            "empty",
          ),
        ]),
  );
  $("#pcb-state").replaceChildren(
    element(
      "span",
      p.kind === "mechanical"
        ? "Not needed for this mechanical project"
        : pcbReady(p)
          ? "Breadboard pass recorded"
          : "Waiting for a breadboard pass",
      "badge",
    ),
  );
  $<HTMLSelectElement>('#evidence-form select[name="stage"]')
    .querySelectorAll<HTMLOptionElement>("option")
    .forEach((o) => {
      o.disabled =
        (p.kind === "mechanical" &&
          ["Breadboard", "PCB bring-up"].includes(o.value)) ||
        (o.value === "PCB bring-up" && !pcbReady(p));
      if (o.disabled && o.selected)
        $<HTMLSelectElement>('#evidence-form select[name="stage"]').value =
          "Measurement";
    });
}
function dimensionLimits(p: Project, side: string) {
  if (p.params.design === "custom") return { min: "1", max: "200" };
  const min = side === "width" ? "25" : side === "depth" ? "20" : "8";
  const max = p.params.design === "cube"
    ? "80"
    : side === "width" ? "200" : side === "depth" ? "160" : "80";
  return { min, max };
}

function showProjectDimensions(p: Project) {
  $("#dimensions-title").textContent =
    p.params.design === "custom" ? "Added design envelope" : "Dimensions";
  $("#dimensions-help").textContent =
    p.params.design === "custom"
      ? "Derived from the CAD plan. Request a change above to revise the model."
      : "Adjust the starter shape, then save the project.";
  $("#wall-label").hidden = p.params.design === "custom";
  for (const [key, value] of Object.entries(p.params).filter(([key]) => key !== "design"))
    ($<HTMLFormElement>("#dimensions").elements.namedItem(key) as HTMLInputElement).value = String(value);
  for (const side of ["width", "depth", "height"]) {
    const input = $<HTMLFormElement>("#dimensions").elements.namedItem(side) as HTMLInputElement;
    const limits = dimensionLimits(p, side);
    input.min = limits.min;
    input.max = limits.max;
    input.readOnly = p.params.design === "custom";
  }
  ($<HTMLFormElement>("#dimensions").elements.namedItem("wall") as HTMLInputElement).readOnly =
    p.params.design === "custom";
}

/** The linked Wiki revision beside the project title: a link when its URL is known. */
function showRevision(p: Project) {
  const r = p.productRevision;
  $("#revision-ref").hidden = !r;
  const link = $<HTMLAnchorElement>("#revision-link");
  link.textContent = r ? r.title || "product revision" : "";
  if (r?.url) link.href = r.url;
  else link.removeAttribute("href");
}

function showTitle(p: Project) {
  $("#project-title").textContent = p.name;
  $("#project-phase").textContent = PHASES.find((phase) => phase.id === p.phase)?.label ?? "";
  document.title = `${p.name} · Workshop`;
  // A rename changes the slug; the ID at its end keeps the old address working.
  const canonical = `${appBase(location.pathname)}${projectPath(projectSlug(p), section)}`;
  if (location.pathname !== canonical) history.replaceState(history.state, "", canonical + location.search);
}
function selectProject(p: Project) {
  project = structuredClone(p);
  dirty = false;
  $("#workspace").hidden = false;
  showTitle(p);
  $("#save-state").textContent = `Saved · revision ${p.revision}`;
  $("#save").setAttribute("disabled", "");
  updateAgentForm();
  showProjectDimensions(p);
  const form = $<HTMLFormElement>("#brief-form");
  for (const key of ["name", "owner", "brief", "requirements", "phase"] as const)
    (form.elements.namedItem(key) as HTMLInputElement).value = p[key];
  const linked = p.productRevision;
  for (const [key, value] of [
    ["revisionLink", linked ? linked.url || linked.id : ""],
    ["revisionTitle", linked?.title ?? ""],
    ["revisionWiki", linked?.wikiInstallationId ?? ""],
  ])
    (form.elements.namedItem(key) as HTMLInputElement).value = value;
  showRevision(p);
  $<HTMLTextAreaElement>("#measurement-notes").value = p.measurementNotes;
  $<HTMLTextAreaElement>("#circuit-notes").value = p.circuitNotes;
  $<HTMLInputElement>("#research-query").value = p.name;
  renderRecords();
  renderConcepts(p);
  showSection();
  lockReadOnlyControls();
}
/** A first prompt from the brief; the member edits it per image. */
function conceptPrompt(p: Project) {
  const requirements = p.requirements.trim();
  return `Concept mockup of ${p.name}: ${p.brief.trim()}${requirements ? ` It must ${requirements[0].toLowerCase()}${requirements.slice(1)}` : ""} A clean product rendering of the physical object as it would ship, on a plain background.`.slice(0, 4000);
}
/** The gallery: image, caption, prompt, model and date, a remove link. */
function renderConcepts(p: Project) {
  const prompt = $<HTMLTextAreaElement>("#concept-prompt");
  if (!prompt.value || prompt.dataset.projectId !== p.id) prompt.value = conceptPrompt(p);
  prompt.dataset.projectId = p.id;
  const linked = (p as { productRevision?: { id: string; url: string } }).productRevision;
  const revision = $<HTMLFormElement>("#concept-publish").elements.namedItem("productRevision") as HTMLInputElement;
  if (!revision.value || revision.dataset.projectId !== p.id) revision.value = linked ? linked.url || linked.id : "";
  revision.dataset.projectId = p.id;
  $("#concept-gallery").replaceChildren(
    ...(p.concepts.length
      ? p.concepts.map((c) => {
          const figure = element("figure"),
            img = element("img"),
            caption = element("figcaption");
          img.src = `/files/main/concepts/${c.key}`;
          img.alt = c.caption || c.prompt.slice(0, 120) || "Concept";
          img.loading = "lazy";
          const line = element("div");
          line.append(
            element("b", c.caption || "Concept"),
            document.createTextNode(` · ${c.model === "upload" ? "uploaded" : c.model} · ${c.createdAt.slice(0, 10)} · `),
          );
          const remove = element("button", "remove", "link");
          remove.type = "button";
          remove.dataset.concept = c.id;
          remove.setAttribute("aria-label", `Remove ${c.caption || "concept"}`);
          line.append(remove);
          caption.append(line);
          if (c.prompt) caption.append(element("p", c.prompt));
          figure.append(img, caption);
          return figure;
        })
      : [element("div", "No concepts yet. Generate one from the prompt, or upload an image made elsewhere.", "empty")]),
  );
}
function lockReadOnlyControls() {
  if (!readOnly) return;
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".workshop input, .workshop textarea, .workshop select")) {
    control.disabled = true;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(".workshop button")) {
    if (!["reset-view", "assembly-reset", "next-action"].includes(button.id)) button.disabled = true;
  }
}

type EntryKey = "parts" | "research" | "evidence";
type Entry = Project[EntryKey][number];
function setEntries(p: Project, key: EntryKey, entries: Entry[]) {
  if (key === "parts") p.parts = entries as Project["parts"];
  else if (key === "research") p.research = entries as Project["research"];
  else p.evidence = entries as Project["evidence"];
}
async function removeProjectEntry(button: HTMLButtonElement) {
  if (readOnly) return;
  if (button.dataset.remove && project) {
    const key = button.dataset.remove as EntryKey;
    const previous: Entry[] = [...project[key]];
    const wasDirty = dirty;
    if (!confirm("Remove this entry?")) return;
    setEntries(
      project,
      key,
      previous.filter((x) => x.id !== button.dataset.id),
    );
    markDirty();
    renderRecords();
    if (!(await save())) {
      setEntries(project, key, previous);
      dirty = wasDirty;
      $("#save-state").textContent = dirty
        ? "Unsaved changes"
        : `Saved · revision ${project.revision}`;
      if (!dirty) $("#save").setAttribute("disabled", "");
      renderRecords();
    }
  }
}

// The page script runs once per visit to the app; each view of a project
// page binds its fresh markup and starts from no selected project.
onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>(".workshop[data-slug]");
  if (!root) return;
  section = (root.dataset.section ?? "overview") as SectionId;
  const slug = root.dataset.slug ?? "";
  project = undefined;
  dirty = false;
  saving = false;
  serialLog = "";
  signal.addEventListener("abort", () => {
    clearTimeout(geometryTimer);
    viewer?.dispose();
    viewer = undefined;
    assemblyPanel?.dispose();
    assemblyPanel = undefined;
    void reader?.cancel();
  });
  document.addEventListener("click", async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.dataset.concept) {
      await conceptRequest(`/${project?.id}/concepts/${button.dataset.concept}`, "DELETE", { revision: project?.revision }, "Removing…", "Remove this concept and its image?");
      return;
    }
    await removeProjectEntry(button);
  }, { signal });
  /**
   * A concept change through the app's API: saves first when the
   * project is dirty, then selects the project revision the answer carries.
   */
  async function conceptRequest(path: string, method: string, body: unknown, pending: string, confirmation?: string) {
    if (readOnly || saving || !project) return;
    if (confirmation && !confirm(confirmation)) return;
    if (dirty && !(await save())) return;
    const status = $("#concept-status");
    status.textContent = pending;
    try {
      loading(true);
      const response = await fetch(`/api/apps/workshop/projects${path}`, {
        method,
        headers: body instanceof Blob ? { "Content-Type": body.type } : { "Content-Type": "application/json" },
        body: body instanceof Blob ? body : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      const answer = await response.json();
      const saved = ProjectSchema.parse(answer);
      selectProject(saved);
      status.textContent = `Saved revision ${saved.revision}.`;
      notice();
    } catch (error) {
      status.textContent = "The request did not complete.";
      notice((error as Error).message);
    } finally {
      loading(false);
    }
  }
  $("#concept-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!project) return;
    const form = $<HTMLFormElement>("#concept-form");
    const { prompt, caption } = formValues(form) as { prompt: string; caption: string };
    if (!prompt.trim()) return;
    await conceptRequest(`/${project.id}/concepts/generate`, "POST", { revision: project.revision, prompt: prompt.trim(), caption: caption.trim() }, "Generating an image… this takes up to a minute.");
  });
  $("#concept-upload").addEventListener("change", async () => {
    const input = $<HTMLInputElement>("#concept-upload");
    const file = input.files?.[0];
    input.value = "";
    if (!file || !project) return;
    const { prompt, caption } = formValues($<HTMLFormElement>("#concept-form")) as { prompt: string; caption: string };
    const query = new URLSearchParams({ revision: String(project.revision), model: "upload", prompt: prompt.trim(), caption: caption.trim() });
    await conceptRequest(`/${project.id}/concepts?${query}`, "POST", file, "Uploading…");
  });
  $("#concept-publish").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (readOnly || saving || !project) return;
    const link = (formValues($<HTMLFormElement>("#concept-publish")) as { productRevision: string }).productRevision;
    // A pasted Wiki link or a bare record id: the last UUID in it is the record.
    const productRevisionId = [...link.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].at(-1)?.[0]?.toLowerCase();
    const status = $("#concept-publish-status");
    if (!productRevisionId) {
      status.textContent = "Paste the revision's Wiki link or ID.";
      return;
    }
    if (dirty && !(await save())) return;
    status.textContent = "Publishing…";
    try {
      loading(true);
      const published = await api<{ documentId: string; url: string | null }>(`/${project.id}/concepts/publish`, "POST", { productRevisionId, revision: project.revision });
      status.replaceChildren(document.createTextNode("Published "), published.url ? sourceLink(published.url, "design concepts ↗") : document.createTextNode(`Document ${published.documentId}`));
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally {
      loading(false);
    }
  });
  $("#agent-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (readOnly || saving || !project) return;
    const form = $<HTMLFormElement>("#agent-form");
    const message = $<HTMLTextAreaElement>("#agent-message").value.trim();
    if (!message) return;
    if (dirty && !(await save())) return;
    const current = project;
    const status = $("#agent-status");
    status.textContent = "Updating model with Spark…";
    try {
      loading(true);
      const response = await fetch("/api/apps/workshop/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          projectId: current.id,
          revision: current.revision,
        }),
      });
      if (!response.ok)
        throw new Error(`${response.status}: ${await response.text()}`);
      const generated = ProjectSchema.parse((await response.json()).project);
      selectProject(generated);
      form.reset();
      status.textContent = agentStatus(generated);
      notice();
      if (section !== "design") {
        goTo("design");
        return;
      }
      $("section[data-panel='design']").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (error) {
      status.textContent =
        "The design request did not complete. Your message is still here to retry.";
      notice((error as Error).message);
    } finally {
      loading(false);
    }
  });
  $("#save").addEventListener("click", () => save());
  $("#brief-form").addEventListener("submit", (e) => e.preventDefault());
  $("#brief-form").addEventListener("input", () => {
    if (!project) return;
    const v = formValues($<HTMLFormElement>("#brief-form"));
    Object.assign(project, {
      name: v.name,
      owner: v.owner,
      brief: v.brief,
      requirements: v.requirements,
      productRevision: productRevisionFrom(
        v.revisionLink,
        v.revisionTitle,
        v.revisionWiki,
      ),
      phase: v.phase,
    });
    showRevision(project);
    markDirty();
  });
  $("#dimensions").addEventListener("submit", (e) => e.preventDefault());
  $("#dimensions").addEventListener("input", (event) => {
    if (!project) return;
    if (project.params.design === "custom") return;
    const dimensionForm = $<HTMLFormElement>("#dimensions");
    if (project.params.design === "cube") {
      const changed = (event.target as HTMLInputElement).name;
      if (["width", "depth", "height"].includes(changed ?? "")) {
        const size = (
          dimensionForm.elements.namedItem(changed) as HTMLInputElement
        ).value;
        for (const side of ["width", "depth", "height"])
          (dimensionForm.elements.namedItem(side) as HTMLInputElement).value =
            size;
      }
    }
    const p = Object.fromEntries(
      Object.entries(formValues(dimensionForm)).map(([k, v]) => [k, Number(v)]),
    );
    project.params = { ...project.params, ...p };
    markDirty();
    renderRecords();
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(renderGeometry, 150);
  });
  $("#measurement-notes").addEventListener("input", () => {
    if (project) {
      project.measurementNotes =
        $<HTMLTextAreaElement>("#measurement-notes").value;
      markDirty();
    }
  });
  $("#circuit-notes").addEventListener("input", () => {
    if (project) {
      project.circuitNotes = $<HTMLTextAreaElement>("#circuit-notes").value;
      markDirty();
      renderRecords();
    }
  });
  $("#next-action").addEventListener("click", () =>
    goTo(project?.research.length ? "design" : "research"),
  );
  $("#reset-view").addEventListener("click", () => viewer?.reset());
  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  for (const format of ["step", "stl"] as const)
    $(`#${format}`).addEventListener("click", async () => {
      if (!project || !viewer) return;
      try {
        if (dirty && !(await save())) return;
        const revision = project.revision,
          projectId = project.id;
        const key = designKey(project),
          blob = await viewer.export(format, project.params, project.cadPlan);
        if (
          key !== designKey(project) ||
          revision !== project.revision ||
          projectId !== project.id
        )
          throw new Error("Dimensions changed during export. Export again.");
        download(blob, `workshop-${projectId}-r${revision}-model.${format}`);
      } catch (e) {
        // Leaving the page disposes the viewer, which rejects its export.
        if (!signal.aborted) notice((e as Error).message);
      }
    });
  function search(kind: string) {
    const query = $<HTMLInputElement>("#research-query").value.trim();
    if (!query) return;
    const base =
      kind === "repos"
        ? "https://github.com/search?type=repositories&q="
        : kind === "models"
          ? "https://www.printables.com/search/models?q="
          : "https://www.google.com/search?q=";
    window.open(
      base + encodeURIComponent(query),
      "_blank",
      "noopener,noreferrer",
    );
  }
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search("web");
  });
  $("#search-repos").addEventListener("click", () => search("repos"));
  $("#search-models").addEventListener("click", () => search("models"));
  bindForm("#research-form", (d, draft) => {
    draft.research.push({
      id: crypto.randomUUID(),
      name: d.name,
      kind: d.kind as Research["kind"],
      url: d.url,
      notes: d.notes,
      decision: d.decision as Research["decision"],
    });
  });
  bindForm("#part-form", (d, draft) => {
    draft.parts.push({
      id: crypto.randomUUID(),
      name: d.name,
      quantity: Number(d.quantity),
      unitCost: Number(d.unitCost),
      source: d.source,
      notes: d.notes,
    });
  });
  bindForm("#evidence-form", (d, draft) => {
    if (
      d.stage === "Breadboard" &&
      d.outcome === "Pass" &&
      !draft.circuitNotes.trim()
    )
      throw new Error(
        "Record the hardware and firmware baseline before accepting the breadboard.",
      );
    if (d.includeSerial && !serialLog)
      throw new Error("There is no serial log to attach.");
    draft.evidence.push({
      id: crypto.randomUUID(),
      stage: d.stage as Evidence["stage"],
      outcome: d.outcome as Evidence["outcome"],
      note: d.note,
      operator: d.operator,
      at: new Date().toISOString(),
      designKey: designKey(draft),
      baselineKey: electricalKey(draft),
      serialLog: d.includeSerial ? serialLog : "",
    });
  });
  $("#package").addEventListener("click", async () => {
    if (readOnly) return;
    if (!project) return;
    try {
      if (dirty && !(await save())) return;
      const res = await fetch(
        `/api/apps/workshop/projects/${project.id}/package`,
      );
      if (!res.ok) throw new Error("Unable to export package");
      download(
        await res.blob(),
        `workshop-${project.id}-r${project.revision}.zip`,
      );
    } catch (e) {
      notice((e as Error).message);
    }
  });
  // Web Serial is missing in most browsers despite the DOM typing.
  const serial = (navigator as Partial<Pick<Navigator, "serial">>).serial;
  if (!serial) {
    $("#serial-connect").setAttribute("disabled", "");
    $("#serial-status").textContent =
      "Web Serial is unavailable in this browser. Use a supported desktop browser for an optional USB connection.";
  }
  $("#serial-connect").addEventListener("click", async () => {
    if (readOnly) return;
    if (port || !serial) return;
    try {
      const selected = await serial.requestPort();
      await selected.open({
        baudRate: Number($<HTMLSelectElement>("#baud").value),
      });
      port = selected;
      if (!selected.readable) throw new Error("Serial port is not readable.");
      const active = selected.readable.getReader();
      reader = active;
      $("#serial-status").textContent = "Connected · reading device output";
      $("#serial-connect").setAttribute("disabled", "");
      $("#serial-disconnect").removeAttribute("disabled");
      serialLog = "";
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await active.read();
        if (done) break;
        serialLog = (serialLog + decoder.decode(value, { stream: true })).slice(
          -4000,
        );
        $("#serial-output").textContent = serialLog;
      }
    } catch (e) {
      $("#serial-status").textContent = (e as Error).message;
    } finally {
      if (reader) {
        reader.releaseLock();
        reader = undefined;
      }
      if (port) {
        try {
          await port.close();
        } catch {}
        port = undefined;
      }
      // Leaving the page cancels the reader; its controls are gone.
      if (!signal.aborted) {
        $("#serial-disconnect").setAttribute("disabled", "");
        $("#serial-connect").removeAttribute("disabled");
        if (serialLog)
          $("#serial-status").textContent =
            "Disconnected · log retained for an observation";
      }
    }
  });
  $("#serial-disconnect").addEventListener("click", async () => {
    await reader?.cancel();
  });
  $("#serial-clear").addEventListener("click", () => {
    serialLog = "";
    $("#serial-output").textContent = "Log cleared.";
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
    }
  }, { signal });
  // A sidebar link would swap the page without beforeunload: load it fully
  // instead, so the browser asks before discarding unsaved changes. Back and
  // forward have already changed the address, so they swap as usual.
  document.addEventListener("astro:before-preparation", (e) => {
    if (dirty && (e as Event & { navigationType: string }).navigationType !== "traverse") e.preventDefault();
  }, { signal });
  async function init() {
    loading(true);
    try {
      // The slug ends with the end of the project's ID.
      const key = slugId(slug);
      const projects = await api<ProjectSummary[]>("");
      if (signal.aborted) return;
      const found = key ? projects.find((p) => p.id.endsWith(key)) : undefined;
      if (!found) {
        $("#project-title").textContent = "Project not found";
        $("#project-missing").hidden = false;
        return;
      }
      const loaded = await api<Project>(`/${found.id}`);
      if (!signal.aborted) selectProject(loaded);
    } catch (e) {
      if (!signal.aborted) notice((e as Error).message);
    } finally {
      if (!signal.aborted) loading(false);
    }
  }
  init();

  $("#delete-project").addEventListener("click", async () => {
    if (readOnly) return;
    if (
      !project ||
      saving ||
      !confirm(
        "Delete this shared project and its evidence for everyone? Export it first if you need a copy.",
      )
    )
      return;
    try {
      loading(true);
      await api(`/${project.id}`, "DELETE", { revision: project.revision });
      dirty = false;
      location.assign(`${appBase(location.pathname)}/`);
    } catch (error) {
      notice((error as Error).message);
      loading(false);
    }
  });
});
