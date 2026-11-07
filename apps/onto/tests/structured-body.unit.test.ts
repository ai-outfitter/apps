import assert from "node:assert/strict";
import test from "node:test";
import { micromark } from "micromark";
import { structuredBodyMarkdown } from "../src/lib/structured-body";

test("schema-guided JSON renders readable sections and safely handles authored text", () => {
  const markdown = structuredBodyMarkdown(
    JSON.stringify({
      mandate: {
        purpose: "Serve **members**. <script>alert(1)</script>",
        approved: false,
      },
      directors: [],
      review: null,
    }),
    {
      type: "object",
      properties: {
        mandate: { title: "Board mandate", $ref: "#/$defs/mandate" },
        directors: { title: "Directors", type: "array" },
        review: {
          title: "Review",
          anyOf: [{ type: "object" }, { type: "null" }],
        },
      },
      $defs: {
        mandate: {
          type: "object",
          properties: {
            purpose: {
              title: "Purpose",
              description: "The organization's reason for existing.",
            },
            approved: { title: "Approved" },
          },
        },
      },
    },
  );
  assert.ok(markdown);
  const html = micromark(markdown, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
  assert.match(html, /<h2>Board mandate<\/h2>/);
  assert.match(html, /<h3>Purpose<\/h3>/);
  assert.match(html, /<strong>members<\/strong>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /None recorded/);
  assert.match(html, /Not specified/);
  assert.match(html, /<p>No<\/p>/);
  assert.doesNotMatch(html, /<script>/);
});
test("ordinary Markdown and malformed JSON use the existing rendering path", () => {
  assert.equal(structuredBodyMarkdown("# Existing note"), null);
  assert.equal(
    structuredBodyMarkdown("# Existing note", { type: "object" }),
    null,
  );
});
