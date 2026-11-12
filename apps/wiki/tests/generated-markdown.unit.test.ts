import assert from "node:assert/strict";
import test from "node:test";
import {generatedMarkdown} from "../src/documents/markdown";
test("generated provenance collapses while raw HTML and unsafe links stay inert",()=>{
 const html=generatedMarkdown('## Needs attention\n\n<details>\n<summary>Sources & provenance</summary>\n\n```json\n{"source":"example"}\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n</details>');
 assert.match(html,/<details><summary>Sources &amp; provenance<\/summary>/);
 assert.match(html,/<code class="language-json">/);
 assert.doesNotMatch(html,/<script>|href="javascript:/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(generatedMarkdown('<details>\n<summary><img src=x onerror=alert(1)></summary>\nx\n</details>'),/<img|<details>/);
});

test("details examples inside fenced code stay literal and unclosed wrappers remain inert",()=>{
 const fenced=generatedMarkdown('```html\n<details>\n<summary>Literal example</summary>\nbody\n</details>\n```');
 assert.doesNotMatch(fenced,/<details>/);
 assert.match(fenced,/&lt;details&gt;/);
 const source=Array.from({length:1000},()=>'<details>\n<summary>Unclosed</summary>\n').join('');
 assert.doesNotMatch(generatedMarkdown(source),/<details>/);
 const nestedFence=generatedMarkdown('<details>\n<summary>Sources</summary>\n\n```html\n</details>\n```\n\nActual source\n</details>');
 assert.match(nestedFence,/<details><summary>Sources<\/summary>/);
 assert.match(nestedFence,/&lt;\/details&gt;/);
 assert.match(nestedFence,/Actual source/);
});
