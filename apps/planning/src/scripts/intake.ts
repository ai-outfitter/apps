import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
const root = document.querySelector<HTMLElement>("#intake-items");
const form = document.querySelector<HTMLFormElement>("#intake-create");
const status = document.querySelector<HTMLElement>("#intake-status");
const focus = "e9500000-0000-4000-8000-000000000001";
agentPage("planning").set({
  focus: {
    kind: "planning-intake",
    id: focus,
    label: "Customer and competitive intake",
    revision: 1,
  },
});
const kinds = [
  "research",
  "architecture",
  "prioritization",
  "backlog",
  "implementation",
  "hardware",
];
async function action(name: string, input: unknown) {
  const response = await fetch("/api/apps/planning/work", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: name, input }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
const element = (tag: string, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};
function append(parent: Node, ...children: (Node | string)[]) {
  for (const child of children)
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
}
let pendingId = crypto.randomUUID();
let pageOffset = 0;
function renderChildren(
  section: HTMLElement,
  children: {
    kind: string;
    rationale: string;
    blocker: string | null;
    result?: { summary: string };
  }[],
) {
  for (const child of children) {
    const card = element("article");
    append(
      card,
      element("h3", child.kind),
      element("p", child.rationale),
      element(
        "p",
        child.blocker ??
          (child.result
            ? "Result submitted for review"
            : "Ready for assigned work"),
      ),
    );
    if (child.result) append(card, element("p", child.result.summary));
    append(section, card);
  }
}
async function fullDetails(parent: HTMLElement, id: string) {
  const value = (await action("intake.get", { intakeId: id })) as {
    body: {
      input: { description: string; sourceUrls?: string[] };
      routes: {
        kind: string;
        result?: {
          summary: string;
          sources: { url: string; observedAt: string }[];
          gaps: string[];
        };
      }[];
    };
  };
  append(parent, element("p", value.body.input.description));
  for (const url of value.body.input.sourceUrls ?? []) {
    const link = element("a", url) as HTMLAnchorElement;
    link.href = url;
    append(parent, link);
  }
  for (const child of value.body.routes) {
    if (!child.result) continue;
    append(
      parent,
      element("h3", child.kind),
      element("p", child.result.summary),
    );
    for (const source of child.result.sources) {
      const link = element(
        "a",
        `${source.url} — observed ${source.observedAt}`,
      ) as HTMLAnchorElement;
      link.href = source.url;
      append(parent, element("p"), link);
    }
    for (const gap of child.result.gaps)
      append(parent, element("p", `Evidence gap: ${gap}`));
  }
}
async function load() {
  if (!root || !status) return;
  root.replaceChildren();
  const rows = (await action("intake.list", {
    offset: pageOffset,
    limit: 20,
  })) as {
    id: string;
    revision: number;
    body: {
      input: { title: string; description: string };
      routes: {
        id: string;
        kind: string;
        rationale: string;
        blocker: string | null;
        result?: { summary: string };
        gate?: { installationId: string; controlId: string };
        dependsOn: string[];
      }[];
    };
  }[];
  const options = (await action("intake.options", {})) as {
    gates: { installationId: string; controlId: string; title: string }[];
  };
  for (const row of rows) {
    const section = element("section");
    append(
      section,
      element("h2", row.body.input.title),
      element("p", row.body.input.description),
    );
    const route = element("button", "Suggest next steps") as HTMLButtonElement;
    route.onclick = () =>
      run(async () => {
        await action("intake.route", {
          intakeId: row.id,
          revision: row.revision,
        });
        await load();
      });
    append(section, route);
    renderChildren(section, row.body.routes);
    const full = element("details") as HTMLDetailsElement;
    append(full, element("summary", "Full intake and evidence"));
    let loaded = false;
    full.addEventListener("toggle", () => {
      if (full.open && !loaded)
        run(async () => {
          await fullDetails(full, row.id);
          loaded = true;
        });
    });
    append(section, full);
    const details = element("details");
    append(details, element("summary", "Choose steps and decision controls"));
    const controls = element("form") as HTMLFormElement;
    for (const kind of kinds) {
      const label = element("label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.name = kind;
      check.checked = row.body.routes.some((c) => c.kind === kind);
      const select = document.createElement("select");
      select.name = `${kind}-gate`;
      append(select, new Option("Choose a decision control", ""));
      for (const gate of options.gates) {
        const option = new Option(gate.title, JSON.stringify(gate));
        const existing = row.body.routes.find(
          (child) => child.kind === kind,
        )?.gate;
        option.selected =
          existing?.controlId === gate.controlId &&
          existing?.installationId === gate.installationId;
        append(select, option);
      }
      const dependencies = document.createElement("select");
      dependencies.name = `${kind}-dependencies`;
      dependencies.multiple = true;
      dependencies.setAttribute("aria-label", `${kind} prerequisites`);
      for (const dependency of kinds.filter((value) => value !== kind)) {
        const option = new Option(dependency, dependency);
        option.selected =
          row.body.routes
            .find((child) => child.kind === kind)
            ?.dependsOn?.includes(dependency) ?? false;
        append(dependencies, option);
      }
      append(label, document.createTextNode("Prerequisites"), dependencies);
      append(label, check, document.createTextNode(kind), select);
      append(controls, label);
    }
    const save = element("button", "Save routing") as HTMLButtonElement;
    save.type = "submit";
    append(controls, save);
    controls.onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        const values = new FormData(controls);
        await action("intake.route", {
          intakeId: row.id,
          revision: row.revision,
          proposal: {
            routes: kinds
              .filter((k) => values.has(k))
              .map((kind) => {
                const value = values.get(`${kind}-gate`);
                const gate = value ? JSON.parse(String(value)) : undefined;
                return {
                  kind,
                  dependsOn: values.getAll(`${kind}-dependencies`).map(String),
                  rationale:
                    row.body.routes.find((child) => child.kind === kind)
                      ?.rationale ?? "Selected by the planning member",
                  ...(gate
                    ? {
                        gate: {
                          installationId: gate.installationId,
                          controlId: gate.controlId,
                        },
                      }
                    : {}),
                };
              }),
          },
        });
        await load();
      });
    };
    append(details, controls);
    append(section, details);
    append(root, section);
  }
  const paging = element("nav");
  paging.setAttribute("aria-label", "Intake pages");
  const previous = element("button", "Newer intake") as HTMLButtonElement;
  previous.disabled = pageOffset === 0;
  previous.onclick = () =>
    run(async () => {
      pageOffset = Math.max(0, pageOffset - 20);
      await load();
    });
  const next = element("button", "Older intake") as HTMLButtonElement;
  next.disabled = rows.length < 20;
  next.onclick = () =>
    run(async () => {
      pageOffset += 20;
      await load();
    });
  append(paging, previous, next);
  append(root, paging);
  status.textContent = rows.length
    ? ""
    : "No intake yet. Describe a customer need or competitive finding to start.";
}
async function run(work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    if (status)
      status.textContent =
        error instanceof Error
          ? error.message
          : "Unable to complete the request";
  }
}
if (import.meta.env.OUTFITTER_APP_MODE === "demo") {
  if (status)
    status.textContent =
      "Read-only demo. Submit and route work in an operational installation.";
} else if (form) {
  run(async () => {
    const response = await fetch("/api/apps/planning");
    if (response.ok) {
      const data = (await response.json()) as {
        projects: { id: string; name: string }[];
      };
      const select = form.elements.namedItem(
        "projectId",
      ) as unknown as HTMLSelectElement;
      for (const project of data.projects)
        append(select, new Option(project.name, project.id));
    }
    await load();
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const values = new FormData(form),
        projectId = String(values.get("projectId"));
      const row = (await action("intake.create", {
        requestId: pendingId,
        title: values.get("title"),
        description: values.get("description"),
        sourceUrls: String(values.get("sourceUrls") ?? "")
          .split(/\s+/)
          .filter(Boolean),
        kind: values.get("kind"),
        ...(projectId ? { projectId } : {}),
      })) as {
        id: string;
        revision: number;
        routes: unknown[];
        routingError?: string;
      };
      pageOffset = 0;
      pendingId = crypto.randomUUID();
      form.reset();
      await load();
      try {
        if (row.routes.length || row.routingError) {
          if (row.routingError && status) status.textContent = row.routingError;
          return;
        }
        await action("intake.route", {
          intakeId: row.id,
          revision: row.revision,
        });
        await load();
      } catch {
        if (status)
          status.textContent =
            "Intake saved. Automatic routing is unavailable; choose steps below or retry Suggest next steps.";
      }
    });
  };
}
