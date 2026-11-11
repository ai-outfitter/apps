import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("data:text/javascript," + encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
  return next(url, context);
}`));
const { ResourceLink } = await import("../src/react/resource-link.tsx");

test("renders a persisted resource-link part as a plain link beneath the assistant reply", () => {
  const entry = {
    id: "reply", role: "assistant", status: "complete", createdAt: 0, recordedAt: null,
    parts: [
      { type: "text", text: "The review is ready." },
      { type: "data", name: "platform.resource-link", version: 1, data: { uri: "https://example.test/review", name: "Review changes" } },
    ],
  };
  const markup = renderToStaticMarkup(React.createElement("article", { className: "message assistant" },
    React.createElement("div", { className: "message-body" },
      React.createElement("p", null, entry.parts[0].text),
      React.createElement(ResourceLink, { data: entry.parts[1].data }))));
  assert.match(markup, /<p>The review is ready\.<\/p><p class="agent-resource-link"><a href="https:\/\/example\.test\/review" target="_blank" rel="noopener noreferrer">Review changes<\/a><\/p>/);
  assert.doesNotMatch(markup, /<button|<section|card/i);
});

test("does not render malformed stored link data", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ResourceLink, { data: { uri: 4, name: "Review" } })), "");
});
