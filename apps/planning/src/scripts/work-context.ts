import type { EntityRecord } from "@ai-outfitter/app-sdk/entities";
import { typeSegment } from "@ai-outfitter/app-sdk/graph-client";
import { wikiHref } from "./wiki-context";
import type { projectContext, previewWork } from "../server/work-packages";
function append(parent: Node, ...children: (Node | string)[]) {
  for (const child of children)
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
}
const root = document.getElementById("work-context");
if (import.meta.env.OUTFITTER_APP_MODE === "operational" && root) {
  const status = root.querySelector<HTMLElement>("#work-context-status")!;
  const records = root.querySelector<HTMLElement>("#work-context-records")!;
  const form = root.querySelector<HTMLFormElement>("form")!;
  const scope = root.querySelector<HTMLElement>("#work-requirement-options")!;
  const select = form.querySelector(
    "select[name=definitionId]",
  ) as unknown as HTMLSelectElement;
  const endpoint = "/api/apps/planning/work-context";
  const projectId = root.dataset.projectId!;
  const fetchJSON = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const text = (tag: string, value: string) => {
    const el = document.createElement(tag);
    el.textContent = value;
    return el;
  };
  function requirementBody(record: EntityRecord): Record<string, unknown> {
    try {
      return JSON.parse(String(record.attributes.body));
    } catch {
      return {};
    }
  }
  function requirementDescription(record: EntityRecord) {
    return String(
      requirementBody(record).statement ??
        record.attributes.body ??
        record.attributes.summary ??
        "",
    );
  }
  function appendCriterionBody(article: HTMLElement, criterion: EntityRecord) {
    try {
      const body = JSON.parse(String(criterion.attributes.body));
      append(
        article,
        text("p", `Condition: ${body.condition ?? "Missing"}`),
        text("p", `Expected outcome: ${body.expectedOutcome ?? "Missing"}`),
      );
    } catch {
      append(
        article,
        text(
          "p",
          "Criterion needs a structured condition and expected outcome.",
        ),
      );
    }
  }
  void (async () => {
    try {
      const context = (await fetchJSON(
        `${endpoint}?projectId=${encodeURIComponent(projectId)}`,
      )) as Awaited<ReturnType<typeof projectContext>>;
      const name = (n: EntityRecord) =>
        String(
          context.types.find((t) => t.ref.id === n.attributes.typeId)
            ?.attributes.name ?? "Entity",
        );
      const href = (n: EntityRecord) =>
        wikiHref(context.wiki, `${typeSegment(name(n))}/${n.ref.id}`);
      for (const requirement of context.requirements) {
        const article = document.createElement("article");
        const link = document.createElement("a");
        link.href = href(requirement);
        link.textContent = requirement.title;
        const heading = document.createElement("h3");
        append(heading, link);
        append(
          article,
          heading,
          text(
            "p",
            `Status: ${requirementBody(requirement).status ?? "unspecified"}`,
          ),
          text("p", requirementDescription(requirement)),
        );
        const linked = context.edges
          .filter(
            (e) =>
              e.attributes.fromId === requirement.ref.id &&
              name(e) === "has_acceptance_criterion",
          )
          .map((e) =>
            context.criteria.find((c) => c.ref.id === e.attributes.toId),
          )
          .filter((n): n is EntityRecord => !!n);
        if (!linked.length)
          append(article, text("p", "No linked acceptance criterion."));
        for (const criterion of linked) {
          const a = document.createElement("a");
          a.href = href(criterion);
          a.textContent = `${criterion.title} · revision ${criterion.revision}`;
          const p = document.createElement("p");
          append(p, a);
          append(article, p);
          appendCriterionBody(article, criterion);
        }
        append(records, article);
        const label = document.createElement("label"),
          checkbox = document.createElement("input");
        label.className = "work-scope-option";
        checkbox.type = "checkbox";
        checkbox.name = "requirementIds";
        checkbox.value = requirement.ref.id;
        checkbox.disabled = requirementBody(requirement).status === "retired";
        append(
          label,
          checkbox,
          document.createTextNode(` ${requirement.title}`),
        );
        append(scope, label);
      }
      const supporting = context.nodes.filter(
        (n) =>
          !["Requirement", "AcceptanceCriterion", "Project", "Issue"].includes(
            name(n),
          ),
      );
      if (supporting.length) {
        const details = document.createElement("details");
        append(details, text("summary", "Supporting project context"));
        const list = document.createElement("ul");
        for (const node of supporting) {
          const item = document.createElement("li"),
            a = document.createElement("a");
          a.href = href(node);
          a.textContent = `${name(node)}: ${node.title}`;
          append(item, a);
          append(list, item);
        }
        append(details, list);
        append(records, details);
      }
      for (const definition of context.definitions)
        select.add(new Option(definition.title, definition.ref.id));
      form.hidden = !context.requirements.length || !context.definitions.length;
      status.textContent = context.gaps.length
        ? context.gaps.join(" ")
        : "Graph records describe intent. Review and authorization happen before execution.";
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Unable to load project context";
    }
  })();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    root.querySelector<HTMLDetailsElement>("#work-preview-output")!.hidden =
      true;
    const requirementIds = new FormData(form)
      .getAll("requirementIds")
      .map(String);
    if (!requirementIds.length) {
      status.textContent = "Select at least one requirement.";
      return;
    }
    const button = form.querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    status.textContent = "Rendering preview…";
    try {
      const preview = (await fetchJSON(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          requirementIds,
          definitionId: select.value,
        }),
      })) as Awaited<ReturnType<typeof previewWork>>;
      root.querySelector("#work-preview-text")!.textContent =
        preview.description;
      const output = root.querySelector<HTMLDetailsElement>(
        "#work-preview-output",
      )!;
      output.hidden = false;
      output.open = true;
      status.textContent = [
        preview.gaps.length
          ? preview.gaps.join(" ")
          : "Preview ready. No execution or submission has been created.",
        ...(preview.warnings ?? []),
      ].join(" ");
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "Unable to preview";
    } finally {
      button.disabled = false;
    }
  });
} else if (root) {
  const status = root.querySelector<HTMLElement>("#work-context-status");
  if (status)
    status.textContent =
      "Connect a Wiki project in an operational installation to prepare work packages.";
}
