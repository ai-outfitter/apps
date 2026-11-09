import type { Graph } from "../lib/graph";
import { typeSegment } from "@ai-outfitter/onto/client";
export { typeSegment } from "@ai-outfitter/onto/client";
export function appUrl(path = "") {
  const depth = Number(document.getElementById("wiki-routing")?.dataset.routeDepth ?? 0);
  const segments = location.pathname.split("/").filter(Boolean);
  return `${segments.slice(0, segments.length - depth).join("/").replace(/^/, "/")}${segments.length > depth ? "/" : ""}${path}`;
}
const nodeRoutes = new Map<string, string>();
const typeRoutes = new Map<string, string>();
function routes(graph: Graph) {
  nodeRoutes.clear();
  typeRoutes.clear();
  for (const type of graph.types) typeRoutes.set(type.id, typeSegment(type.name));
  for (const node of graph.nodes) nodeRoutes.set(node.id, typeRoutes.get(node.typeId) ?? "entities");
  return graph;
}
/** A type's registry name (what definitions and URL params use), or `fallback`. */
export const typeName = (graph: Pick<Graph, "types">, id: string, fallback = id) => graph.types.find((t) => t.id === id)?.name ?? fallback;
export const entityUrl = (id: string, typeId?: string) => appUrl(`${(typeId && typeRoutes.get(typeId)) || nodeRoutes.get(id) || "entities"}/${encodeURIComponent(id)}`);
export const demoMode = import.meta.env.OUTFITTER_APP_MODE === "demo";
export async function call<T>(operation: string, input?: unknown): Promise<T> {
  if (demoMode) throw new Error("This demo is read-only.");
  const response = await fetch(
    appUrl(`api/apps/wiki-map/${operation}`),
    input
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : {},
  );
  if (!response.ok) throw new Error(await response.text());
  if (input) graphRequest = undefined;
  return response.json() as Promise<T>;
}
let graphRequest: Promise<Graph> | undefined;
let graphMount = "";
export function loadGraph(): Promise<Graph> {
  const mount = appUrl();
  if (mount !== graphMount) { graphMount = mount; graphRequest = undefined; }
  graphRequest ??= (async () => {
    const graph = demoMode ? (await import("../../fixtures/graph")).demoGraph : await call<Graph>("graph/snapshot");
    return mount === graphMount ? routes(graph) : graph;
  })();
  return graphRequest;
}
type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { class: className, ...rest } = props;
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(rest)) {
    if (key.startsWith("aria-")) element.setAttribute(key, String(value));
    else Object.assign(element, { [key]: value });
  }
  if (className) element.className = String(className);
  element.replaceChildren(
    ...children.filter((v): v is Node | string => v !== false && v != null),
  );
  return element;
}
export const link = (label: string, id: string, type = "node") =>
  el("a", { href: type === "type" ? appUrl(`types/${encodeURIComponent(id)}`) : entityUrl(id) }, label);
export function notice(message: string) {
  const n = document.getElementById("notice");
  if (n) n.textContent = message;
}
