import { readinessStages, type ProjectReadiness } from "../project-readiness";

function append(parent: Node, ...children: (Node | string)[]) {
  for (const child of children)
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
}

function gapList(title: string, gaps: string[]) {
  const label = document.createElement("p");
  label.textContent = title;
  const list = document.createElement("ul");
  for (const gap of gaps) {
    const item = document.createElement("li");
    item.textContent = gap;
    append(list, item);
  }
  return [label, list];
}

export function readinessSummary(
  value: ProjectReadiness | undefined,
  compact = false,
) {
  const container = document.createElement("div");
  container.className = "planning-readiness";
  if (!value) {
    container.textContent =
      "Readiness not assessed. Linked graph context is unavailable.";
    return container;
  }
  container.dataset.stage = value.stage;
  const label = document.createElement("strong");
  label.textContent =
    readinessStages.find((s) => s.id === value.stage)?.title ?? "Needs framing";
  append(container, label);
  const signal = document.createElement("p");
  signal.className = "planning-readiness-signal";
  signal.textContent = value.signals.join(" · ");
  if (signal.textContent) append(container, signal);
  if (value.missing.length) {
    append(container, 
      ...gapList(
        value.stage === "frame" ? "To start planning:" : "To prepare the work:",
        compact ? value.missing.slice(0, 3) : value.missing,
      ),
    );
    if (compact && value.missing.length > 3) {
      const rest = document.createElement("small");
      rest.textContent = `+${value.missing.length - 3} more on the project page`;
      append(container, rest);
    }
  }
  if (!compact && value.priorityGaps.length) {
    append(container, 
      ...gapList(
        "Optional product context for priority (not a work readiness gate):",
        value.priorityGaps,
      ),
    );
  }
  return container;
}

export function readinessRules() {
  const details = document.createElement("details");
  details.className = "planning-readiness-rules";
  const summary = document.createElement("summary");
  summary.textContent = "How readiness and priority work";
  append(details, summary);
  for (const stage of readinessStages) {
    const row = document.createElement("p");
    const title = document.createElement("strong");
    title.textContent = `${stage.title}: `;
    append(row, title, stage.description);
    append(details, row);
  }
  const note = document.createElement("p");
  note.textContent =
    "Readiness applies to hiring, IT and other organizational work: identify the people or roles involved, their need, the desired outcome, requirements and observable acceptance criteria. Product, offering and demonstration links are optional priority context; association with an existing product counts without creating a new product. A tool merely used by the project does not count as its product context. These graph-completeness signals do not verify completion, approval or execution authority. Project prose alone does not count as linked evidence.";
  append(details, note);
  return details;
}
