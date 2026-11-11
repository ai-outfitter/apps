import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("renders the stored resource link as a plain named link under the reply", () => {
  const markup = renderToStaticMarkup(<article className="message assistant"><div className="message-body">
    <p className="agent-resource-link"><a href="https://example.test/review">Review changes</a></p>
  </div></article>);
  assert.match(markup, /<article class="message assistant"><div class="message-body"><p class="agent-resource-link"><a href="https:\/\/example\.test\/review">Review changes<\/a>/);
  assert.doesNotMatch(markup, /button|section|card/i);
});
