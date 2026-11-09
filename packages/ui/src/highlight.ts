import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import "./styles/code.css";

// Only the languages registered here are bundled; highlight.js core adds about 20 KB.
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);

export type CodeLanguage = "json" | "markdown";

/** Escaped source wrapped in `hljs-*` class spans (no inline styles; code.css colors them). */
export function highlightHTML(code: string, language: CodeLanguage) {
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

/** Fill `pre` with highlighted `code`, for pages built without React. */
export function highlightInto(pre: HTMLElement, code: string, language: CodeLanguage) {
  const element = document.createElement("code");
  element.className = `hljs language-${language}`;
  element.innerHTML = highlightHTML(code, language);
  pre.classList.add("code-block");
  pre.replaceChildren(element);
}
