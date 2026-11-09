// The explore page: draws an exploration, tells the Wiki sidebar agent which one
// is open, re-reads it when that agent finishes a reply, and writes the same
// merge patch the agent sends (MutateExploration) when a member opens a path or
// hides a node.
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { typeSegment } from "@ai-outfitter/onto/client";
import { createKnowledgeGraphViewer, disposeKnowledgeGraphViewers } from "@ai-outfitter/ui/knowledge-graph";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { appUrl, call, demoMode, el } from "./data";

type Node = { key: string; type: string; title: string; slug: string | null; id: string; step: string | null; url: string | null; proposedIn?: string | null };
type Step = { from: string; path: string; direction?: string; limit?: number; type?: string };
type Exploration = {
  slug: string; title: string; revision: number;
  state: { title: string; start: { type: string; slug: string }; steps: Record<string, Step>; hidden: Record<string, true>; direction?: "RIGHT" | "DOWN" };
  lastChange: { by: string; via: string; summary: string; nodes: string[] } | null;
  picture: { nodes: Node[]; edges: { from: string; to: string; label: string }[]; steps: { key: string; count: number; truncated: boolean; error: string | null }[]; truncated: boolean };
};

const paths: Record<string, { label: string; from?: string[] }> = {
  offerings: { label: "Offerings", from: ["Organization"] },
  products: { label: "Products", from: ["Offering"] },
  projects: { label: "Projects", from: ["Organization", "Offering", "Product"] },
  competitors: { label: "Competitors", from: ["Offering", "Product", "UseCase", "UserStory"] },
  issues: { label: "Issues" },
  repositories: { label: "Repositories", from: ["Project"] },
  pullRequests: { label: "Open pull requests", from: ["Project", "Repository"] },
};
const pathLabel = (path: string) => paths[path]?.label.toLowerCase() ?? path.replaceAll("_", " ");
const shortKey = (key: string) => key.replace(/^[^:]+:/, "");
const nodeHref = (node: Node) => node.proposedIn ? appUrl(`changes/${encodeURIComponent(node.proposedIn)}`)
  : node.type === "PullRequest" && node.url ? node.url : appUrl(`${typeSegment(node.type)}/${encodeURIComponent(node.id)}`);
/** What the picture shows; a change (an agent's step, a staged proposal, new data) redraws it. */
const signature = (exploration: Exploration) => JSON.stringify([exploration.revision, exploration.picture.nodes.map((node) => [node.key, node.title, node.proposedIn ?? null]), exploration.picture.edges]);
/** A readable step key that is not taken yet, e.g. projects-2. */
const stepKey = (exploration: Exploration, path: string) => {
  let key = path.replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "step";
  for (let n = 2; exploration.state.steps[key]; n++) key = `${path}-${n}`;
  return key;
};

/** The shared viewer's input: types by name, edges labelled by relationship, and the nodes the last change added. */
function viewerInput(exploration: Exploration) {
  const { nodes, edges } = exploration.picture;
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const types = [...new Set(nodes.map((node) => node.type))].map((type) => ({ id: type, name: type, title: type }));
  const labels = [...new Set(edges.map((edge) => edge.label))].map((label) => ({ id: `edge:${label}`, name: label.replaceAll("_", " "), title: label.replaceAll("_", " ") }));
  const graph = {
    types: [...types, ...labels],
    nodes: nodes.map((node) => ({ id: node.id, typeId: node.type, title: node.title })),
    edges: edges.flatMap((edge, index) => {
      const from = byKey.get(edge.from), to = byKey.get(edge.to);
      return from && to ? [{ id: `e${index}`, typeId: `edge:${edge.label}`, fromId: from.id, toId: to.id, properties: {} }] : [];
    }),
  };
  const startNode = nodes.find((node) => node.step === null) ?? nodes[0];
  const start = startNode && graph.nodes.find((node) => node.id === startNode.id);
  const highlight = new Set((exploration.lastChange?.nodes ?? []).map((key) => byKey.get(key)?.id).filter((id): id is string => !!id));
  const proposed = nodes.filter((node) => node.proposedIn).map((node) => node.id);
  return { graph, start, highlight, proposed, nodes };
}

onPageLoad(async (signal) => {
  const root = document.getElementById("exploration");
  if (!root?.dataset.slug) return;
  const slug = root.dataset.slug;
  root.closest(".ui-content")?.classList.add("wiki-graph-content");
  const heading = document.querySelector<HTMLElement>(".ui-content h1");
  const change = el("p", { class: "exploration-change", role: "status" });
  const output = el("div", { class: "exploration-graph" });
  const selected = el("div", { class: "exploration-selected", "aria-live": "polite" });
  const steps = el("details", { class: "exploration-steps" });
  const problem = el("p", { role: "alert", hidden: true });
  root.replaceChildren(change, problem, output, selected, steps);
  let current: Exploration | undefined, focusKey: string | undefined, busy = false;
  // The read-only demo resolves its fixture in the browser; clicks change this page's copy only.
  const backend = demoMode
    ? await import("../../fixtures/exploration").then(({ demoExploration }) => {
      const demo = demoExploration();
      return { read: () => demo.read() as Promise<Exploration>, mutate: (input: unknown) => demo.mutate(input) as Promise<Exploration> };
    })
    : {
      read: () => call<Exploration>(`explorations/get?slug=${encodeURIComponent(slug)}`),
      mutate: (input: unknown) => call<Exploration>("explorations/mutate", input),
    };

  const write = async (patch: Record<string, unknown>, summary: string) => {
    if (!current || busy) return;
    busy = true;
    try {
      const next = await backend.mutate({ slug, expectedRevision: current.revision, patch, summary });
      problem.hidden = true;
      render(next);
    } catch (error) {
      problem.hidden = false;
      problem.textContent = String(error instanceof Error ? error.message : error);
      await read().catch(() => undefined);
    } finally { busy = false; }
  };

  const showSelected = () => {
    const node = current?.picture.nodes.find((item) => item.key === focusKey);
    if (!current || !node) { selected.replaceChildren(); return; }
    const exploration = current;
    const link = (text: string, action: () => void) => el("button", { type: "button", class: "exploration-link", onclick: action }, text);
    if (node.proposedIn) {
      selected.replaceChildren(el("h2", {}, node.title, " ", el("span", { class: "exploration-type" }, `Proposed ${node.type}`)),
        el("p", {}, el("a", { href: nodeHref(node) }, "Review the change batch"), " to add it to the Wiki."));
      return;
    }
    const open = Object.entries(paths).filter(([, path]) => node.type !== "PullRequest" && (!path.from || path.from.includes(node.type))).map(([path, { label }]) =>
      link(label, () => write({ steps: { [stepKey(exploration, path)]: { from: node.key, path } } }, `Opened ${label.toLowerCase()} from ${node.title}`)));
    const isStart = node.key === `${exploration.state.start.type}:${exploration.state.start.slug}`;
    selected.replaceChildren(
      el("h2", {}, el("a", { href: nodeHref(node) }, node.title), " ", el("span", { class: "exploration-type" }, node.type)),
      el("nav", { class: "exploration-actions", "aria-label": `Explore from ${node.title}` }, ...open,
        ...(isStart ? [] : [link("Hide", () => write({ hidden: { [node.key]: true } }, `Hid ${node.title}`))])),
    );
  };

  const showSteps = (exploration: Exploration) => {
    const results = new Map(exploration.picture.steps.map((step) => [step.key, step]));
    const title = (key: string) => exploration.picture.nodes.find((node) => node.key === key)?.title ?? shortKey(key);
    const hidden = Object.keys(exploration.state.hidden);
    steps.replaceChildren(
      el("summary", {}, "Steps"),
      el("ul", {}, ...Object.entries(exploration.state.steps).map(([key, step]) => {
        const result = results.get(key);
        const from = step.from.startsWith("*") ? `every ${pathLabel(exploration.state.steps[step.from.slice(1)]?.path ?? step.from.slice(1))} result` : title(step.from);
        return el("li", {}, `${pathLabel(step.path)[0].toUpperCase()}${pathLabel(step.path).slice(1)} from ${from}`,
          result?.error ? el("span", { class: "exploration-error" }, ` · ${result.error}`) : result?.truncated ? " · limited" : "",
          " ", el("button", { type: "button", class: "exploration-link", onclick: () => write({ steps: { [key]: null } }, `Closed ${pathLabel(step.path)}`) }, "Remove"));
      })),
      ...(hidden.length ? [el("p", {}, "Hidden: ", ...hidden.flatMap((key, index) => [index ? ", " : "", shortKey(key), " ",
        el("button", { type: "button", class: "exploration-link", onclick: () => write({ hidden: { [key]: null } }, `Showed ${shortKey(key)}`) }, "Show")]))] : []),
    );
  };

  function drawGraph(exploration: Exploration) {
    const { graph, start, highlight, proposed, nodes } = viewerInput(exploration);
    disposeKnowledgeGraphViewers(output);
    output.replaceChildren(start
      ? createKnowledgeGraphViewer(graph, graph, start, {
        direction: exploration.state.direction ?? "RIGHT", highlight, proposed,
        nodeHref: (id) => { const node = nodes.find((item) => item.id === id); return node ? nodeHref(node) : "#"; },
        onError: (error) => { problem.hidden = false; problem.textContent = `Unable to arrange graph: ${String(error)}`; },
      })
      : el("p", {}, "Nothing to show."));
    if (exploration.picture.truncated) output.appendChild(el("p", { class: "exploration-note" }, "Showing the first 300 nodes. Hide some or remove a step to see the rest."));
  }

  function render(exploration: Exploration) {
    const changed = !current || signature(exploration) !== signature(current);
    current = exploration;
    if (heading) heading.textContent = exploration.title;
    root?.setAttribute("aria-busy", "false");
    change.textContent = exploration.lastChange ? exploration.lastChange.via === "member" ? exploration.lastChange.summary : `${exploration.lastChange.summary} · ${exploration.lastChange.by}` : "";
    if (changed) drawGraph(exploration);
    agentPage("onto").describe({ title: exploration.title,
      summary: `Exploration "${exploration.slug}" at revision ${exploration.revision}. Change it with the MutateExploration document; stage new records as a change batch.`,
      state: { exploration: exploration.slug, revision: exploration.revision, start: exploration.state.start, steps: Object.keys(exploration.state.steps) } });
    showSteps(exploration);
    if (!focusKey || !exploration.picture.nodes.some((node) => node.key === focusKey)) focusKey = exploration.picture.nodes.find((node) => node.step === null)?.key;
    showSelected();
  }

  // Selecting a node shows what can be opened from it; its title links to the record.
  output.addEventListener("click", (event) => {
    const target = (event.target as Element).closest("[data-graph-node]");
    if (!target || !current) return;
    event.preventDefault();
    focusKey = current.picture.nodes.find((node) => node.id === target.getAttribute("data-graph-node"))?.key;
    showSelected();
    selected.querySelector("button")?.focus();
  }, { signal });

  async function read() {
    render(await backend.read());
  }
  // The sidebar agent changes this exploration with MutateExploration (or stages
  // records); its finished reply is when the page reads it again.
  const page = agentPage("onto");
  signal.addEventListener("abort", page.onReplied(() => {
    if (busy) return;
    read().then(() => { problem.hidden = true; }, (error) => { problem.hidden = false; problem.textContent = String(error instanceof Error ? error.message : error); });
  }));
  try { await read(); } catch (error) {
    root.setAttribute("aria-busy", "false");
    problem.hidden = false;
    problem.textContent = String(error instanceof Error ? error.message : error);
  }
});
