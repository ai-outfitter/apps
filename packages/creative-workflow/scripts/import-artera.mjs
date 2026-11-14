/** Read-only source importer; writes a private transport manifest, never the source repository. */
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { resolveArtera, historicalCandidate } from "../src/artera.ts";
const [repository, deckRelative, output] = process.argv.slice(2);
if (!repository || !deckRelative || !output)
  throw Error(
    "Usage: import-artera.mjs REPOSITORY DECK_RELATIVE_PATH PRIVATE_OUTPUT.json",
  );
const repo = await realpath(repository),
  deck = resolve(repo, deckRelative),
  out = resolve(output);
if (out.startsWith(repo + "/"))
  throw Error("Keep the import manifest outside the source repository");
if (!deck.startsWith(repo + "/")) throw Error("Deck escapes repository");
const files = {},
  images = {};
async function load(path, active = []) {
  const absolute = await realpath(resolve(repo, path));
  if (!absolute.startsWith(repo + "/"))
    throw Error("Reference escapes repository");
  if (files[path] !== undefined) return;
  const text = await readFile(absolute, "utf8");
  files[path] = text;
  for (const m of text.matchAll(/@([\w./-]+\.md)/g))
    await load(relative(repo, resolve(dirname(absolute), m[1])), [
      ...active,
      path,
    ]);
  for (const m of text.matchAll(
    /@(wiki\/sources\/[\w./-]+\.(?:jpg|jpeg|png))/g,
  )) {
    const file = await realpath(resolve(repo, m[1]));
    if (!file.startsWith(repo + "/")) throw Error("Image escapes repository");
    const bytes = await readFile(file);
    images[m[1]] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
}
const names = (await readdir(join(deck, "prompts")))
  .filter((n) => /^(IMG|FIG)-.*\.md$/.test(n))
  .sort();
const roots = names.map((n) => relative(repo, join(deck, "prompts", n)));
for (const path of roots) await load(path);
const resolved = [];
for (const name of names)
  resolved.push(
    await resolveArtera({
      image: name.slice(0, -3),
      files,
      roots,
      images,
      deckPrefix: relative(repo, deck) + "/",
    }),
  );
async function optional(path, fallback) {
  try {
    const real = await realpath(path);
    if (!real.startsWith(repo + "/")) throw Error("Source escapes repository");
    return await readFile(real, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
const history = (await optional(join(deck, "candidates/provenance.jsonl"), ""))
  .split("\n")
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const snapshots = {};
for (const row of history) {
  if (!row.prompt) continue;
  if (!/^[a-f0-9]{16}$/.test(row.prompt))
    throw Error("Invalid historical snapshot hash");
  const text = await optional(
    join(deck, "candidates/prompts", row.prompt, "manifest.json"),
    "",
  );
  const resolved = await optional(
    join(deck, "candidates/prompts", row.prompt, "resolved.txt"),
    null,
  );
  if (text && resolved !== null)
    snapshots[row.prompt] = { manifest: JSON.parse(text), text: resolved };
}
const candidates = [];
for (const row of history) {
  if (
    typeof row.image !== "string" ||
    row.image !== row.image.split("/").at(-1) ||
    row.image.includes("..")
  )
    throw Error("Invalid candidate filename");
  const file = join(deck, "candidates", row.image);
  let artifact = null;
  try {
    const real = await realpath(file);
    if (!real.startsWith(repo + "/"))
      throw Error("Candidate escapes repository");
    const bytes = await readFile(real);
    artifact = {
      file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  candidates.push({ ...historicalCandidate(row, snapshots), artifact });
}
// Retain surviving renders even when the original candidate ledger is absent.
// Their provenance remains unknown; today's prompt is never attached to them.
for (const directory of ["candidates", "public/renders"]) {
  let entries = [];
  try {
    entries = await readdir(join(deck, directory));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const name of entries
    .filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n))
    .sort()) {
    if (candidates.some((c) => c.source.image === name)) continue;
    const file = await realpath(join(deck, directory, name));
    if (!file.startsWith(repo + "/")) throw Error("Render escapes repository");
    const bytes = await readFile(file);
    candidates.push({
      source: { image: name, sourcePath: relative(repo, file) },
      snapshot: null,
      provenance: "unknown",
      artifact: {
        file,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }
}
const feedback = (await optional(join(deck, "candidates/feedback.jsonl"), ""))
  .split("\n")
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const selections = JSON.parse(
  await optional(join(deck, "selected.json"), "{}"),
);
const picked = new Set(
  feedback.filter((f) => f.verdict === "pick").map((f) => f.image),
);
const manifest = {
  format: "artera-creative-import/1",
  source: { repository: repo, deck: deckRelative },
  files,
  images,
  resolved,
  candidates,
  feedback,
  selections: Object.entries(selections).map(([slot, file]) => ({
    slot,
    file,
    explicit: picked.has(file),
  })),
};
manifest.hash = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(out, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(
  JSON.stringify({
    output: out,
    hash: manifest.hash,
    prompts: resolved.length,
    candidates: candidates.length,
    unknown: candidates.filter((c) => c.provenance === "unknown").length,
  }),
);
