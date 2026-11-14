import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freeze, drift, selectedCandidate } from "../src/index.ts";
import { resolveArtera, historicalCandidate } from "../src/artera.ts";
const input = {
  root: "scene",
  fragments: [
    {
      id: "scene",
      revision: 1,
      text: "A spacecraft",
      references: ["craft", "style"],
    },
    {
      id: "craft",
      revision: 1,
      text: "A rectangular hull",
      references: ["style"],
    },
    { id: "style", revision: 1, text: "Photoreal", references: [] },
  ],
  inputs: [
    { provider: "reference", recordId: "hull", contentHash: "a".repeat(64) },
  ],
  settings: { model: "example", seed: 1 },
};
test("recursive composition freezes settings and reference bytes, independent of supplied order", async () => {
  const a = await freeze(input),
    b = await freeze({ ...input, fragments: [...input.fragments].reverse() });
  assert.equal(a.hash, b.hash);
  assert.equal(a.text, "Photoreal\n\n\nA rectangular hull\n\n\nA spacecraft");
  assert.deepEqual(drift(a, b), { state: "current", changed: [] });
  const c = await freeze({
    ...input,
    settings: { ...input.settings, seed: 2 },
  });
  assert.deepEqual(drift(a, c), {
    state: "stale",
    changed: ["generation settings"],
  });
  const d = await freeze({
    ...input,
    inputs: [{ ...input.inputs[0], contentHash: "b".repeat(64) }],
  });
  assert.deepEqual(drift(a, d).changed, ["reference artifacts"]);
});
test("changed fragments identify affected candidates, unknown is not stale, selection never advances", async () => {
  const a = await freeze(input),
    b = await freeze({
      ...input,
      fragments: input.fragments.map((f) =>
        f.id === "craft"
          ? { ...f, revision: 2, text: "A cylindrical hull" }
          : f,
      ),
    });
  assert.deepEqual(drift(a, b).changed, ["craft"]);
  assert.equal(drift(null, b).state, "unknown");
  assert.equal(
    selectedCandidate([{ id: "old" }, { id: "new" }], "old")?.id,
    "old",
  );
  assert.equal(selectedCandidate([{ id: "new" }], null), null);
});
test("missing references and cycles fail with actionable paths", async () => {
  await assert.rejects(
    freeze({ ...input, fragments: input.fragments.slice(0, 2) }),
    /Missing prompt fragment: style/,
  );
  await assert.rejects(
    freeze({
      ...input,
      fragments: input.fragments.map((f) =>
        f.id === "style" ? { ...f, references: ["scene"] } : f,
      ),
    }),
    /scene → craft → style → scene/,
  );
});
test("legacy resolver preserves Artera byte order and image hash identity", async () => {
  const files = {
    "prompts/IMG-01.md": "Scene @../craft.md",
    "prompts/IMG-02.md": "Other @../craft.md",
    "craft.md": "Hull @style.md",
    "style.md": "Photoreal",
  };
  const result = await resolveArtera({
    image: "IMG-01",
    files,
    roots: ["prompts/IMG-01.md", "prompts/IMG-02.md"],
  });
  const text = "Hull style\n\n\nPhotoreal\n\n\nScene craft";
  assert.equal(result.text, text);
  assert.equal(
    result.hash,
    createHash("sha256").update(text).digest("hex").slice(0, 16),
  );
  const image = { sha256: "a".repeat(64), bytes: 10 };
  const photo = await resolveArtera({
    image: "IMG-01",
    files: {
      ...files,
      "prompts/IMG-01.md": "Scene @../craft.md @wiki/sources/test/photo.png",
    },
    roots: ["prompts/IMG-01.md", "prompts/IMG-02.md"],
    images: { "wiki/sources/test/photo.png": image },
  });
  const expected = createHash("sha256")
    .update(
      createHash("sha256").update(photo.text).digest("hex") +
        "\nwiki/sources/test/photo.png " +
        image.sha256,
    )
    .digest("hex")
    .slice(0, 16);
  assert.equal(photo.hash, expected);
  assert.equal(
    historicalCandidate({ image: "old.png" }, {}).provenance,
    "unknown",
  );
});

test("legacy changed-layer reporting preserves the recorded file groups", async () => {
  const { arteraDrift } = await import("../src/artera.ts");
  const previous = {
    hash: "1111111111111111",
    layers: [
      {
        name: "spacecraft",
        hash: createHash("sha256")
          .update("DESIGN.mdoriginal")
          .digest("hex")
          .slice(0, 16),
        files: ["DESIGN.md"],
      },
    ],
  };
  const result = await arteraDrift(previous, "2222222222222222", {
    "DESIGN.md": "revised",
  });
  assert.equal(result.state, "stale");
  assert.deepEqual(result.changed, ["spacecraft"]);
  assert.equal(
    (await arteraDrift(null, "2222222222222222", {})).state,
    "unknown",
  );
});
