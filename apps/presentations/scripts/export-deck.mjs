/** Export a pinned graph storyboard and selected local artifacts into a Slidev source directory.
 * No model calls, network downloads, package installation or publishing. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
const [input, directory] = process.argv.slice(2);
if (!input || !directory)
  throw Error(
    "Usage: export-deck.mjs PINNED_MANIFEST.json NEW_OUTPUT_DIRECTORY",
  );
const manifest = JSON.parse(await readFile(input, "utf8"));
if (
  !manifest.storyboard?.id ||
  !manifest.storyboard?.revision ||
  !Array.isArray(manifest.storyboard.body?.items)
)
  throw Error("A pinned storyboard record is required");
const out = resolve(directory);
await mkdir(out);
await mkdir(join(out, "public"));
await writeFile(
  join(out, "package.json"),
  JSON.stringify(
    { name: "creative-deck-export", private: true, type: "module" },
    null,
    2,
  ) + "\n",
);
const slides = [];
const escape = (text) =>
  String(text)
    .replace(/[<>{}]/g, "")
    .replace(/^---$/gm, "—");
for (const item of manifest.storyboard.body.items) {
  let body = `# ${escape(item.title)}\n\n${escape(item.narrative)}`;
  const selected = manifest.selections.find((s) => s.slot === item.id);
  if (selected) {
    if (!selected.candidate?.id || !selected.candidate?.revision)
      throw Error("Selected candidate must be pinned");
    const bytes = await readFile(selected.file);
    if (createHash("sha256").update(bytes).digest("hex") !== selected.sha256)
      throw Error("Selected artifact hash mismatch");
    const name = basename(selected.file);
    if (!/^[A-Za-z0-9._-]+\.(png|jpg|jpeg)$/i.test(name))
      throw Error("Selected slide image must be PNG/JPEG");
    const target = `${selected.sha256.slice(0, 16)}-${name}`;
    await copyFile(selected.file, join(out, "public", target));
    body += `\n\n<img src="/${target}" alt="Selected illustration" style="max-height: 240px; max-width: 100%; object-fit: contain; margin: 1rem auto;" />`;
  }
  slides.push(body);
}
await writeFile(
  join(out, "slides.md"),
  "---\ntheme: default\n---\n\n" + slides.join("\n\n---\n\n") + "\n",
);
await writeFile(
  join(out, "creative-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Slidev source saved to ${out}. Render with the project-pinned Slidev toolchain, then upload PDF and source ZIP through Presentations MCP.`,
);
