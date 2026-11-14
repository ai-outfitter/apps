/** Legacy resolver adapter. Receives files from an importer, never accesses a filesystem. */
import { digest } from "./index.ts";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const base = (p: string) => p.split("/").at(-1)!;
function join(parent: string, path: string) {
  const parts = parent.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!parts.length) throw Error("Reference escapes supplied root");
      parts.pop();
    } else if (part !== "." && part) parts.push(part);
  }
  return parts.join("/");
}
export async function resolveArtera(input: {
  image: string;
  files: Record<string, string>;
  roots: string[];
  images?: Record<string, { sha256: string; bytes: number }>;
  deckPrefix?: string;
}) {
  const diagnostics = new Set<string>();
  const prefix = input.deckPrefix ?? "",
    root = `${prefix}prompts/${input.image}.md`,
    labels = (p: string) => {
      const a = prefix.split("/").filter(Boolean),
        b = p.split("/");
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return "../".repeat(a.length - i) + b.slice(i).join("/");
    };
  function tree(start: string) {
    const files: string[] = [],
      seen = new Set<string>(),
      active: string[] = [];
    function visit(path: string) {
      if (active.includes(path)) {
        diagnostics.add(
          `Legacy cycle resolved once: ${[...active, path].join(" → ")}`,
        );
        return;
      }
      if (seen.has(path)) return;
      if (!(path in input.files))
        throw Error(`Missing prompt fragment: ${path}`);
      seen.add(path);
      active.push(path);
      files.push(path);
      for (const m of input.files[path].matchAll(/@([\w./-]+\.md)/g))
        visit(join(path, m[1]));
      active.pop();
    }
    visit(start);
    return files;
  }
  const counts = new Map<string, number>();
  for (const start of input.roots)
    for (const p of tree(start)) counts.set(p, (counts.get(p) ?? 0) + 1);
  const files = tree(root),
    ordered = files
      .filter((p) => p !== root)
      .sort(
        (a, b) =>
          (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
          compare(labels(a), labels(b)),
      );
  ordered.push(root);
  const text = ordered
    .map((p) =>
      input.files[p]
        .trim()
        .replace(/@([\w./-]+)\.md/g, (_, name: string) => base(name)),
    )
    .join("\n\n\n");
  const inputs: { path: string; sha256: string; bytes: number }[] = [],
    seen = new Set<string>();
  for (const p of files)
    for (const m of input.files[p].matchAll(
      /@(wiki\/sources\/[\w./-]+\.(?:jpg|jpeg|png))/g,
    )) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const image = input.images?.[m[1]];
      if (!image) throw Error(`Missing reference image: ${m[1]}`);
      inputs.push({ path: m[1], ...image });
    }
  const textHash = await digest(text),
    hash = (
      inputs.length
        ? await digest(
            `${textHash}\n${inputs.map((i) => `${i.path} ${i.sha256}`).join("\n")}`,
          )
        : textHash
    ).slice(0, 16);
  return {
    resolver: "artera/legacy",
    hash,
    text,
    inputs,
    files: files.map(labels),
    diagnostics: [...diagnostics],
  };
}
/** No current prompt is inferred for a historical candidate lacking a saved snapshot. */
export function historicalCandidate(
  row: Record<string, unknown>,
  snapshots: Record<string, unknown>,
) {
  const hash = typeof row.prompt === "string" ? row.prompt : null;
  return {
    source: row,
    snapshot: hash ? (snapshots[hash] ?? null) : null,
    provenance: hash && snapshots[hash] ? "recorded" : "unknown",
  };
}
export async function verifyLegacySnapshot(saved: {
  hash: string;
  text: string;
  manifest: Record<string, unknown>;
}) {
  const inputs = (saved.manifest.inputs ?? []) as {
    path: string;
    sha256: string;
  }[];
  if (
    !Array.isArray(inputs) ||
    inputs.some(
      (i) => typeof i.path !== "string" || !/^[a-f0-9]{64}$/.test(i.sha256),
    )
  )
    throw Error("Invalid legacy reference-image manifest");
  const textHash = await digest(saved.text);
  const hash = (
    inputs.length
      ? await digest(
          `${textHash}\n${inputs.map((i) => `${i.path} ${i.sha256}`).join("\n")}`,
        )
      : textHash
  ).slice(0, 16);
  if (hash !== saved.hash)
    throw Error(
      "Legacy snapshot text or inputs do not match its recorded hash",
    );
}
/** Attribute legacy drift using the exact file groups recorded at generation time.
 * The caller supplies today's authoritative legacy tree hash and authorized file bytes. */
export async function arteraDrift(
  previous: {
    hash: string;
    layers?: { name: string; hash: string; files: string[] }[];
  } | null,
  currentHash: string,
  filesByLabel: Record<string, string>,
) {
  if (!previous)
    return {
      state: "unknown" as const,
      current: currentHash,
      renderedFrom: null,
      changed: [] as string[],
    };
  if (previous.hash === currentHash)
    return {
      state: "current" as const,
      current: currentHash,
      renderedFrom: previous.hash,
      changed: [] as string[],
    };
  const changed: string[] = [];
  for (const layer of previous.layers ?? []) {
    if (
      layer.files.some((path) => !(path in filesByLabel)) ||
      (
        await digest(
          layer.files.map((path) => path + filesByLabel[path]).join(""),
        )
      ).slice(0, 16) !== layer.hash
    )
      changed.push(layer.name);
  }
  if (previous.hash !== currentHash && !changed.length)
    changed.push("reference inputs or dependency order");
  return {
    state:
      previous.hash === currentHash ? ("current" as const) : ("stale" as const),
    current: currentHash,
    renderedFrom: previous.hash,
    changed,
  };
}
