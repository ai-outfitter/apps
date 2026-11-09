import Markdown from "@ai-outfitter/ui/react/Markdown";

/** Astro passes page text as a named prop; Markdown's children stay React text. */
export default function ReleaseContent({ content }: { content: string }) {
  return <Markdown>{content}</Markdown>;
}
