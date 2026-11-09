import { type CodeLanguage, highlightHTML } from "../highlight";

/** A highlighted code block (highlight.ts); JSON by default. */
export default function CodeBlock({ code, language = "json" }: { code: string; language?: CodeLanguage }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped source wrapped in class spans.
  return <pre className="code-block"><code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlightHTML(code, language) }} /></pre>;
}

/** A value as highlighted, indented JSON. */
export function JsonBlock({ value }: { value: unknown }) {
  return <CodeBlock code={JSON.stringify(value, null, 2)} />;
}
