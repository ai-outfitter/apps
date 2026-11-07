/** Preserve the installation mount, entity ID, nested view and query string. */
export function canonicalProductRoute(url: URL, nodeType?: string) {
  if (nodeType !== "software-products") return undefined;
  const segment = "/software-products";
  const offset = url.pathname.lastIndexOf(segment);
  return url.pathname.slice(0, offset) + "/products" + url.pathname.slice(offset + segment.length) + url.search;
}
