import type { ElkLabel } from "elkjs/lib/elk-api";
import type {
  KnowledgeGraphData as Graph,
  KnowledgeGraphNode as GraphNode,
  KnowledgeGraphSlice as View,
} from "./model";
import type { KnowledgeGraphLayout } from "./layout";
import "../styles/knowledge-graph.css";
export type {
  KnowledgeGraphData,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
  KnowledgeGraphSlice,
} from "./model";
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") element.className = String(value);
    else if (key.startsWith("aria-")) element.setAttribute(key, String(value));
    else Object.assign(element, { [key]: value });
  }
  element.replaceChildren(...children);
  return element;
}
const disposers = new WeakMap<Element, () => void>();
let markerSequence = 0;
/** Release observers before replacing a graph's DOM, including closed panels. */
export function disposeKnowledgeGraphViewers(
  root: Pick<ParentNode, "querySelectorAll">,
) {
  for (const stage of root.querySelectorAll(".knowledge-graph-stage"))
    disposers.get(stage)?.();
}
const ns = "http://www.w3.org/2000/svg";
// appendChild avoids the Cloudflare HTMLRewriter Element.append overload in the root typecheck.
function append(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}
function draw(
  parent: Element,
  tag: string,
  attrs: Record<string, string>,
  text?: string,
) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, value);
  if (text) element.textContent = text;
  append(parent, element);
  return element;
}
function label(
  parent: Element,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
) {
  draw(parent, "rect", {
    x: String(x),
    y: String(y),
    width: String(width),
    height: String(height),
    rx: String(height / 2),
    class: "kg-edge-label-background",
  });
  draw(
    parent,
    "text",
    {
      x: String(x + width / 2),
      y: String(y + height / 2 + 4),
      "text-anchor": "middle",
      class: "kg-edge-label",
    },
    text,
  );
}
function renderEdges(
  svg: Element,
  result: KnowledgeGraphLayout,
  marker: string,
) {
  for (const edge of result.layout.edges ?? []) {
    for (const section of edge.sections ?? []) {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      const d = points
        .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
        .join(" ");
      draw(svg, "path", {
        d,
        "data-graph-edge": edge.id,
        "data-record-ids": JSON.stringify(result.edgeRecords.get(edge.id)),
        fill: "none",
        stroke: "currentColor",
        "stroke-opacity": "0.6",
        "stroke-linejoin": "round",
        ...(result.stems.has(edge.id)
          ? {}
          : { "marker-end": `url(#${marker})` }),
      });
    }
    renderLabels(svg, edge.labels ?? []);
  }
}
function renderLabels(svg: Element, labels: ElkLabel[]) {
  for (const item of labels)
    label(
      svg,
      item.x ?? 0,
      item.y ?? 0,
      item.width ?? 80,
      item.height ?? 28,
      item.text ?? "",
    );
}
function titleLines(title: string) {
  const words = title.split(/\s+/),
    lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > 31) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length > 2 ? [lines[0], `${lines[1].slice(0, 28)}…`] : lines;
}
function renderNodes(
  svg: Element,
  graph: Graph,
  result: KnowledgeGraphLayout,
  nodeHref: (id: string) => string,
) {
  for (const node of result.layout.children ?? []) {
    const x = node.x ?? 0,
      y = node.y ?? 0,
      width = node.width ?? 240,
      height = node.height ?? 90;
    const group = result.groups.get(node.id);
    if (group) {
      const junction = draw(svg, "g", { "data-relation-group": group.label });
      draw(
        junction,
        "title",
        {},
        `${group.label}: ${group.edges.length} recorded relationships`,
      );
      label(
        junction,
        x,
        y,
        width,
        height,
        `${group.label} · ${group.edges.length}`,
      );
      continue;
    }
    const record = result.records.get(node.id);
    if (!record) continue;
    const link = draw(svg, "a", {
      href: nodeHref(record.id),
      "data-graph-node": record.id,
    });
    draw(link, "title", {}, record.title);
    draw(link, "rect", {
      x: String(x),
      y: String(y),
      width: String(width),
      height: String(height),
      rx: "10",
      class: "kg-node",
    });
    const lines = titleLines(record.title);
    lines.forEach((text, index) => {
      draw(
        link,
        "text",
        { x: String(x + 14), y: String(y + 27 + index * 18) },
        text,
      );
    });
    draw(
      link,
      "text",
      { x: String(x + 14), y: String(y + height - 14), class: "kg-node-type" },
      graph.types.find((type) => type.id === record.typeId)?.title ?? "Entity",
    );
  }
}
export function createKnowledgeGraphViewer(
  graph: Graph,
  view: View,
  anchor: GraphNode,
  options: {
    direction?: "RIGHT" | "DOWN";
    initialScale?: number;
    nodeHref: (id: string) => string;
    onError?: (error: unknown) => void;
  },
) {
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${anchor.title}: knowledge graph`);
  const loading = el("p", { role: "status" }, "Arranging graph…");
  const viewport = el(
    "div",
    {
      class: "knowledge-graph-viewport",
      tabIndex: 0,
      "aria-label": "Scrollable knowledge graph",
    },
    loading,
    svg,
  );
  let disposed = false;
  let width = 1,
    height = 1,
    scale = 1,
    autoFit = options.initialScale === undefined,
    ready = false;
  const resize = (next: number) => {
    scale = Math.max(0.1, next);
    svg.setAttribute("width", String(width * scale));
    svg.setAttribute("height", String(height * scale));
  };
  // Fit the whole graph, but keep cards readable: a tall graph fits the width
  // (up to a readable scale) and scrolls vertically instead of shrinking.
  const fitGraph = () => {
    autoFit = true;
    if (!ready) return;
    const fitWidth = viewport.clientWidth / width;
    const fitAll = Math.min(fitWidth, viewport.clientHeight / height);
    resize(Math.max(fitAll, Math.min(fitWidth, 0.85)));
  };
  const observer = new ResizeObserver(() => {
    if (!viewport.isConnected) {
      observer.disconnect();
      return;
    }
    if (autoFit && viewport.clientWidth >= 650) fitGraph();
  });
  observer.observe(viewport);
  const control = (title: string, action: () => void) =>
    el(
      "button",
      {
        type: "button",
        class: "ui-button ui-button--secondary",
        onclick: action,
      },
      title,
    );
  const zoom = (factor: number) => {
    autoFit = false;
    resize(scale * factor);
  };
  void import("./layout")
    .then(({ layoutKnowledgeGraph }) => layoutKnowledgeGraph(graph, view, { direction: options.direction }))
    .then((result) => {
      if (disposed || !viewport.isConnected) return;
      width = result.layout.width ?? 1;
      height = result.layout.height ?? 1;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      // SVG marker IDs only need DOM uniqueness, including on HTTP VPN origins.
      const markerId = `kg-arrow-${Date.now()}-${++markerSequence}`;
      const defs = draw(svg, "defs", {});
      const marker = draw(defs, "marker", {
        id: markerId,
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "6",
        markerHeight: "6",
        orient: "auto-start-reverse",
      });
      draw(marker, "path", {
        d: "M 0 0 L 10 5 L 0 10 z",
        fill: "currentColor",
      });
      renderEdges(svg, result, markerId);
      renderNodes(svg, graph, result, options.nodeHref);
      loading.remove();
      ready = true;
      if (options.initialScale !== undefined) {
        resize(options.initialScale);
        const position = result.layout.children?.find(node => node.id === anchor.id);
        viewport.scrollLeft = Math.max(0, ((position?.x ?? 0) + (position?.width ?? 0) / 2) * scale - viewport.clientWidth / 2);
      } else if (viewport.clientWidth >= 650) fitGraph();
      else resize(1);
    })
    .catch((error) => {
      if (disposed) return;
      loading.textContent = "The graph could not be arranged.";
      options.onError?.(error);
    });
  const stage = el("div", { class: "knowledge-graph-stage", tabIndex: -1 });
  const expand = control("Expand graph", () => {
    const expanded = stage.classList.toggle("knowledge-graph-expanded");
    expand.textContent = expanded ? "Close expanded graph" : "Expand graph";
    autoFit = true;
    if (expanded) stage.focus();
  });
  stage.onkeydown = (event) => {
    if (
      event.key === "Escape" &&
      stage.classList.contains("knowledge-graph-expanded")
    ) {
      expand.click();
      expand.focus();
    }
  };
  append(
    stage,
    el(
      "nav",
      { class: "graph-actions", "aria-label": "Graph zoom" },
      expand,
      control("Fit graph", fitGraph),
      control("Zoom in", () => zoom(1.25)),
      control("Zoom out", () => zoom(1 / 1.25)),
    ),
    viewport,
  );
  disposers.set(stage, () => {
    disposed = true;
    observer.disconnect();
    disposers.delete(stage);
  });
  return stage;
}
