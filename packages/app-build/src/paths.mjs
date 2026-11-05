// Shared by packaging, provisioning, smoke checks and the authenticated dispatcher.
/** @param {string} path */
export function isManagedAssetPath(path) {
  return (
    /^\/_astro\/[a-zA-Z0-9_@./-]+\.(?:js|css|wasm|woff|woff2)$/.test(path) &&
    !path.includes("..") &&
    !path.includes("/./") &&
    !path.includes("//")
  );
}
/** @param {string} path */
export function isWorkerModuleName(path) {
  return (
    /^[a-zA-Z0-9_@./-]+\.m?js$/.test(path) &&
    !path.includes("..") &&
    !path.includes("/./") &&
    !path.includes("//") &&
    !path.startsWith("/") &&
    !path.startsWith("./")
  );
}

/** @param {string} path */
export function managedAssetContentType(path) {
  /** @type {Record<string, string>} */
  const types = {
    js: "text/javascript",
    css: "text/css",
    wasm: "application/wasm",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  return types[path.slice(path.lastIndexOf(".") + 1)] ?? null;
}
