import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// CSS side-effect imports resolve to empty modules under Node.
register("data:text/javascript," + encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  return next(url, context);
}`));
const { default: Timeline } = await import("../src/react/timeline/Timeline.tsx");

const entry = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, role: "event", status: "complete", createdAt: 0, recordedAt: null, parts, ...extra }) as never;

test("typed parts render, unsupported extensions fall back to escaped structured data", () => {
  const html = renderToStaticMarkup(createElement(Timeline, {
    timestamps: "recorded",
    entries: [
      entry("a", [{ type: "attempt", attemptId: "1", nodeId: "implement", state: "failed", failure: "Checks failed" }], { recordedAt: Date.UTC(2026, 9, 30) }),
      entry("b", [{ type: "workflow-output", name: "implement.outputs.result", complete: false, value: { candidate: { number: 9 } } }]),
      entry("c", [{ type: "data", name: "other-app.card", version: 2, data: { title: "<script>alert(1)</script>", nested: [1, { deep: true }] } }]),
      entry("d", [{ type: "brand-new-part", value: 1 }]),
    ],
  }));
  assert.match(html, /Checks failed/);
  assert.match(html, /incomplete/);
  assert.match(html, /Structured content: <code>other-app\.card v2<\/code>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "extension data is escaped text");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /brand-new-part/, "unknown part types are kept, not dropped");
  assert.equal((html.match(/no recorded time/g) ?? []).length, 3, "history entries without a source time show none");
});

test("artifacts link only when available; missing, expired and incomplete are explicit", () => {
  const html = renderToStaticMarkup(createElement(Timeline, {
    entries: [entry("a", [
      { type: "artifact", name: "ok.tar", availability: "available", url: "/api/platform/artifacts/1?installation=f" },
      { type: "artifact", name: "gone.tar", availability: "missing", url: "/should-not-link" },
      { type: "artifact", name: "old.tar", availability: "expired" },
      { type: "artifact", name: "part.tar", availability: "incomplete" },
    ])],
  }));
  assert.match(html, /href="\/api\/platform\/artifacts\/1\?installation=f"/);
  assert.doesNotMatch(html, /should-not-link/);
  assert.match(html, /Missing:/);
  assert.match(html, /Expired:/);
  assert.match(html, /Incomplete:/);
});

test("a data part is labelled by the schema its provider published, and still shown generically", () => {
  const schemas = [{ name: "other-app.card", version: 2, kind: "part" as const, title: "Review card", schema: { type: "object" } }];
  const html = renderToStaticMarkup(createElement(Timeline, {
    schemas,
    entries: [entry("s", [{ type: "data", name: "other-app.card", version: 2, data: { verdict: "ok" } }, { type: "data", name: "other-app.plain", data: 1 }])],
  }));
  assert.match(html, /Review card: <code>other-app\.card v2<\/code>/);
  assert.match(html, /Structured content: <code>other-app\.plain<\/code>/);
  assert.match(html, /verdict/);
});
