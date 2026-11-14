// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import { disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { relationshipCard, type RelationshipGraph } from "./relationship-cards";
import { planningWikiContext } from "./wiki-context";
import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import type { Project } from "../server/schema";
onPageLoad(() => {
  const root = document.querySelector("[data-use-cases]");
  if (!root) return;
  const demo = import.meta.env.OUTFITTER_APP_MODE === "demo";
  const get = <T = HTMLDivElement>(id: string): T => {
    const element = root.querySelector(`#${id}`);
    if (!element) throw new Error(`Missing use-case element: ${id}`);
    return element as T;
  };
  const notice = get<HTMLParagraphElement>("use-case-notice");
  const project = get<HTMLSelectElement>("use-case-project");
  let wiki: {
    installationId: string;
    hostname: string | null;
    slug: string;
    writable: boolean;
  } = { installationId: "", hostname: null, slug: "", writable: false };
  const form = get<HTMLFormElement>("use-case-editor"),
    list = get<HTMLDivElement>("use-case-list");
  const create = get<HTMLButtonElement>("new-use-case");
  const fields = {
    actor: "Actor",
    goal: "Goal",
    trigger: "Trigger and preconditions",
    steps: "Main flow",
    alternatives: "Alternatives and failures",
    successCriteria: "Success criteria",
  };
  let rows: EntityRecord[] = [];
  let graph: RelationshipGraph | undefined;
  let projects: Project[] = [];
  let generation = 0,
    busy = false;
  const editable = () => !demo && wiki.writable;
  const projectFor = (row: EntityRecord) => {
    const properties = row.attributes.properties as
      Record<string, unknown> | undefined;
    return projects.find(
      (p) =>
        p.id === properties?.project_id &&
        p.installationId === properties?.planning_installation_id,
    );
  };
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    if (import.meta.env.OUTFITTER_APP_MODE === "demo")
      throw new Error("Read-only demo");
    const response = await fetch(
      `/api/apps/planning${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  function buttons() {
    create.disabled = busy || !editable() || !projects.length;
    project.disabled = busy || !!form.dataset.id;
    form.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled = busy;
    });
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    buttons();
    try {
      await work();
    } catch (error) {
      notice.textContent =
        error instanceof Error ? error.message : "Unable to save use case";
    } finally {
      busy = false;
      buttons();
    }
  }
  function parseDocument(row: EntityRecord): Record<string, string> {
    const document = JSON.parse(String(row.attributes.body));
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      Object.keys(document).some((key) => !(key in fields)) ||
      Object.keys(fields).some((key) => typeof document[key] !== "string")
    )
      throw new Error(
        "This Wiki document has a different structure. Edit it in Wiki to preserve its fields.",
      );
    return document;
  }
  function edit(row?: EntityRecord) {
    // Decode before changing an open draft so incompatible Wiki content cannot erase it.
    const document = row ? parseDocument(row) : {};
    form.reset();
    form.dataset.id = row?.ref.id ?? "";
    form.dataset.revision = String(row?.revision ?? "");
    project.value = row ? (projectFor(row)?.id ?? "") : (projects[0]?.id ?? "");
    project.disabled = !!row;
    if (row) {
      field("title").value = row.title;
      field("summary").value = String(row.attributes.summary ?? "");
      // Invalid external documents stay visible as an error, never silently blanked.
      for (const key of Object.keys(fields))
        field(key).value = String(document[key] ?? "");
    }
    get("use-case-editor-title").textContent = row
      ? "Edit use case"
      : "New use case";
    form.hidden = false;
    field("title").focus();
  }
  function render() {
    disposeKnowledgeGraphViewers(list);
    list.replaceChildren();
    get("use-case-empty").hidden = !wiki.installationId || rows.length > 0;
    for (const row of rows) {
      const { card, detail } = relationshipCard(
        row,
        graph,
        projectFor(row)?.name,
        wiki,
      );
      let doc: Record<string, unknown>;
      try {
        doc = parseDocument(row);
      } catch {
        doc = {};
        const raw = document.createElement("p");
        raw.textContent = String(row.attributes.body ?? "");
        detail.appendChild(raw);
      }
      for (const [key, label] of Object.entries(fields)) {
        const heading = document.createElement("h3");
        heading.textContent = label;
        const value = document.createElement("p");
        value.textContent = String(doc[key] || "Not written yet.");
        detail.appendChild(heading);
        detail.appendChild(value);
      }
      const actions = document.createElement("div");
      actions.className = "planning-toolbar";
      for (const [label, action] of [
        ["Edit", async () => edit(row)],
        [
          "Archive",
          async () => {
            if (!confirm(`Archive ${row.title}? It will remain in Wiki.`))
              return;
            await api("/use-cases", {
              projectId: projectFor(row)?.id,
              id: row.ref.id,
              revision: row.revision,
              title: row.title,
              summary: row.attributes.summary,
              document: parseDocument(row),
              archived: true,
            });
            await load();
            notice.textContent = "Archived in Wiki";
          },
        ],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-button ui-button--secondary";
        button.textContent = label;
        button.disabled = !editable() || !projectFor(row);
        button.onclick = () => void run(action);
        actions.appendChild(button);
      }
      detail.appendChild(actions);
      list.appendChild(card);
    }
  }
  async function load() {
    const current = ++generation;
    const result = wiki.installationId
      ? await api<{ records: EntityRecord[]; graph: RelationshipGraph }>(
          "/discovery/use-cases",
        )
      : { records: [], graph: undefined };
    if (current !== generation) return;
    rows = result.records;
    graph = result.graph;
    render();
    buttons();
    notice.textContent = "Use cases loaded from Wiki";
  }
  create.onclick = () => edit();
  get("cancel-use-case").onclick = () => (form.hidden = true);
  form.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      await api("/use-cases", {
        projectId: project.value,
        title: field("title").value,
        summary: field("summary").value,
        document: Object.fromEntries(
          Object.keys(fields).map((key) => [key, field(key).value]),
        ),
        ...(form.dataset.id
          ? { id: form.dataset.id, revision: Number(form.dataset.revision) }
          : {}),
      });
      form.hidden = true;
      await load();
      notice.textContent = "Saved to Wiki";
    });
  };
  if (demo) {
    wiki.installationId = "demo";
    project.add(new Option("Improve team planning", "demo"));
    project.value = "demo";
    rows = [
      {
        ref: { installationId: "demo", type: "graph-node", id: "demo" },
        revision: 1,
        title: "Choose the next issue",
        references: [],
        attributes: {
          summary:
            "A team member can find useful work without losing the project goal.",
          body: JSON.stringify({
            actor: "Team member",
            goal: "Choose a useful next task",
            trigger: "The member is ready for work",
            steps:
              "Open the project, review its goals and choose an unblocked issue.",
            alternatives:
              "If every issue is blocked, record the decision needed.",
            successCriteria:
              "The member can explain which project goal the chosen issue supports.",
          }),
        },
      },
    ];
    render();
    buttons();
    notice.textContent = "Read-only example";
  } else
    void run(async () => {
      const [choices, data] = await Promise.all([
        planningWikiContext(),
        api<{ projects: Project[] }>(""),
      ]);
      wiki = choices;
      projects = data.projects;
      for (const p of projects) project.add(new Option(p.name, p.id));
      if (data.projects.length === 1) project.value = data.projects[0].id;
      await load();
    });
});
