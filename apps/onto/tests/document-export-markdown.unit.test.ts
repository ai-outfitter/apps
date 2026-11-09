import assert from "node:assert/strict";
import test from "node:test";
import { obsidianLinks } from "../src/server/exports/markdown";

test("vault formatting preserves fenced code, images, escaped links and complex labels", () => {
  const url = "https://example.test/a",
    link = `[Receipt](${url})`;
  const untouched = [
    `~~~md\n${link}\n~~~`,
    `\`\`\`md\n${link}\n\`\`\``,
    `\`${link}\``,
    `!${link}`,
    `\\${link}`,
    `[*Receipt*](${url})`,
  ];
  const text = [link, ...untouched].join("\n\n");
  assert.equal(
    obsidianLinks(text, new Map([[url, "Notes/A"]])),
    ["[[Notes/A|Receipt]]", ...untouched].join("\n\n"),
  );
});
