/** One bounded line of display text: no markup, controls or line breaks. Card
 * and projection summaries come from the `summary` field, never the Markdown body. */
export function plainText(value: string, limit: number) {
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]+/g, " ")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
