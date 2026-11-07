import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Replace explicit plain-text links using parser offsets, preserving all other
 * bytes. Code, images, references, HTML and formatted link labels stay intact. */
export function obsidianLinks(
  markdown: string,
  mappings: ReadonlyMap<string, string>,
): string {
  const replacements: { start: number; end: number; value: string }[] = [];
  function visit(node: MarkdownNode) {
    if (node.type === "link") {
      const target = node.url && mappings.get(node.url);
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      const plain = node.children?.every((child) => child.type === "text");
      const label =
        node.children?.map((child) => child.value ?? "").join("") ?? "";
      if (
        target &&
        plain &&
        label &&
        !/[\[\]|\r\n]/.test(label) &&
        start !== undefined &&
        end !== undefined
      )
        replacements.push({ start, end, value: `[[${target}|${label}]]` });
      return;
    }
    if (
      ["code", "inlineCode", "image", "imageReference", "html"].includes(
        node.type,
      )
    )
      return;
    for (const child of node.children ?? []) visit(child);
  }
  visit(fromMarkdown(markdown));
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, replacement.start) +
      replacement.value +
      markdown.slice(replacement.end);
  return markdown;
}
