import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceView,
  safeEvidenceURL,
  visualEvidenceJSONSchema,
  visualEvidenceSchema,
} from "@ai-outfitter/app-sdk/visual-evidence";
import { capture } from "./fixtures/visual-evidence";

test("schema and runtime preserve screenshot-only, video-only, mixed and no-media captures", () => {
  assert.equal(visualEvidenceJSONSchema.type, "object");
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        new URL("../docs/visual-evidence.schema.json", import.meta.url),
        "utf8",
      ),
    ),
    visualEvidenceJSONSchema,
  );
  const parsed = visualEvidenceSchema.parse(capture);
  assert.equal(parsed.steps[0].media[0].sha256, "b".repeat(64));
  for (const media of [
    [],
    [
      {
        ...capture.steps[0].media[0],
        id: "movie",
        kind: "video",
        contentType: "video/mp4",
        href: "/movie.mp4",
      },
    ],
    capture.steps[0].media,
  ]) {
    assert.equal(
      visualEvidenceSchema.parse({
        ...capture,
        steps: [{ ...capture.steps[0], media }],
      }).steps.length,
      1,
    );
  }
});
test("reject incompatible media, duplicate IDs and malformed provenance", () => {
  assert.equal(
    visualEvidenceSchema.safeParse({
      ...capture,
      steps: [capture.steps[0], capture.steps[0]],
    }).success,
    false,
  );
  assert.equal(
    visualEvidenceSchema.safeParse({
      ...capture,
      source: { ...capture.source, commit: "main" },
    }).success,
    false,
  );
  assert.equal(
    visualEvidenceSchema.safeParse({
      ...capture,
      steps: [
        {
          ...capture.steps[0],
          media: [{ ...capture.steps[0].media[0], kind: "video" }],
        },
      ],
    }).success,
    false,
  );
  for (const url of [
    "javascript:alert(1)",
    "//foreign.example/a.png",
    "https://name:secret@example.com/a.png",
    "/\\evil.com/a.png",
  ])
    assert.equal(safeEvidenceURL(url), false);
});
test("legacy adaptation retains media and never invents hash or provenance", () => {
  const view = evidenceView(
    { id: "old", revision: 2, title: "Original", body: "Original notes" },
    [
      {
        id: "demo",
        title: "Run",
        media: [
          "https://example.com/a.png",
          "https://example.com/b.mp4",
          "https://example.com/manifest.json",
          "javascript:alert(1)",
        ],
      },
    ],
  );
  assert.equal(view.steps[0].media.length, 2);
  assert.equal(view.source, undefined);
  assert.equal(view.steps[0].media[0].sha256, undefined);
  assert.match(
      evidenceView({
        id: "invalid",
        revision: 1,
        title: "Bad",
        body: JSON.stringify({ recordKind: "visual-evidence" }),
      }).limitations[0],
    /schema/,
  );
});
