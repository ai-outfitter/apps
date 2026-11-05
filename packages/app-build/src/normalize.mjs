// Astro generates a new server-island encryption key for every clean build.
// With no compiled islands that key protects nothing, but it changes the entire
// managed package identity. Normalize only a provably empty island manifest;
// packages with islands or an unfamiliar compiler output keep their real key.
export function normalizeUnusedIslandKey(modules) {
  const islands = Object.entries(modules).filter(([name]) => /\/_virtual_astro_server-island-manifest_[^/]+\.mjs$/.test(name));
  if (islands.length !== 1) return;
  const code = islands[0][1]
    .replace(/^globalThis\.process(?:\.env)? \?\?= \{\};\s*$/gm, "")
    .replace(/\/\/#(?:region|endregion)[^\n]*/g, "")
    .replace(/\/\* @__PURE__ \*\//g, "")
    .replace(/\s+/g, "");
  if (code !== "varserverIslandMap=newMap([]);varserverIslandNameMap=newMap([]);export{serverIslandMap,serverIslandNameMap};") return;
  for (const [name, source] of Object.entries(modules)) {
    modules[name] = source.replace(/(var _manifest = deserializeManifest\()(\{[^\n]+\})(\);)/g, (match, prefix, json, suffix) => {
      const manifest = JSON.parse(json);
      if (typeof manifest.key !== "string") return match;
      // A valid but unused AES key. Never used for an app containing islands.
      manifest.key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      return prefix + JSON.stringify(manifest) + suffix;
    });
  }
}
