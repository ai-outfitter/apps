/** Compare a private import with the unchanged original Artera implementation. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
const [repository, deck, manifestPath] = process.argv.slice(2);
if (!repository || !deck || !manifestPath)
  throw Error(
    "Usage: verify-artera.mjs REPOSITORY DECK_RELATIVE_PATH IMPORT_MANIFEST.json",
  );
const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")),
  repo = resolve(repository);
process.chdir(repo);
const original = await import(
  pathToFileURL(resolve(repo, deck, "review/src/lib/prompt-tree.ts")).href
);
for (const prompt of manifest.resolved) {
  const image = basename(prompt.files[0], ".md");
  assert.equal(
    prompt.text,
    original.resolvedText(image),
    `${image}: resolved bytes changed`,
  );
  assert.equal(
    prompt.hash,
    original.treeHash(image),
    `${image}: legacy hash changed`,
  );
}
console.log(
  `Matched exact text and legacy hashes for ${manifest.resolved.length} Artera prompts`,
);
