/** A created element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Appends nodes and text to a parent. The repo's root type check also loads
 * Cloudflare's HTMLRewriter `Element`, whose `append` overload shadows the
 * DOM one, so page scripts append through this helper.
 */
export function append<T extends HTMLElement>(parent: T, ...children: (Node | string)[]) {
  for (const child of children) parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  return parent;
}

/** A run's state as a small pill: saved, ready, running or failed. */
export function statusPill(status = "") {
  const tone = status === "Saved" ? "ok" : status === "Failed" ? "failed" : status === "Running" ? "running" : "pending";
  return el("span", `source-pill source-pill--${tone}`, status);
}
