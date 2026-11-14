import { type AnchorHTMLAttributes, lazy, Suspense } from "react";

type MarkdownModule = typeof import("react-markdown");

/** Message text before (or without) the markdown parser. */
function PlainText({ children }: { children?: string }) {
  return <div style={{ whiteSpace: "pre-wrap" }}>{children}</div>;
}

// The markdown parser is large and the chat shell works without it, so the
// browser loads it as its own chunk and starts the download as soon as this
// module is evaluated. React keeps the server-rendered HTML of each hydrating
// boundary until the chunk arrives; text that first appears in the browser
// shows as plain text meanwhile. The server cannot suspend (a lazy component
// would leave its fallback in the HTML), so it waits for the parser once.
const parser = import("react-markdown").catch(() => ({
  default: PlainText as MarkdownModule["default"],
}));
// `import.meta.env` exists only under Vite; plain Node (unit tests) renders like the server.
const Rendered = (import.meta.env?.SSR ?? typeof window === "undefined")
  ? (await parser).default
  : lazy(() => parser);

/**
 * Markdown for chat and workspace messages. Images are not rendered: a reply
 * can quote mail or web text written by others, and an image URL would be
 * fetched as soon as it shows, carrying whatever the URL holds.
 */
/** A link out of a mounted app is a full page load, never a client-router swap. */
function PlatformLink({ node: _node, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return <a {...props} data-astro-reload="" />;
}

// The parser's own URL sanitizer, applied before a host maps root-relative links.
let sanitize: ((url: string) => string) | undefined;
void import("react-markdown").then((module) => {
  sanitize = module.defaultUrlTransform;
}, () => undefined);

/**
 * `linkURL` maps a root-relative link (`/workflows/…/runs/…`) to where this page
 * reaches it, for hosts mounted under the platform; other links are only
 * sanitized.
 */
export default function Markdown({ children, linkURL }: { children: string; linkURL?: (path: string) => string }) {
  const urlTransform = linkURL
    ? (url: string) => {
        const safe = sanitize ? sanitize(url) : url;
        return safe.startsWith("/") && !safe.startsWith("//") ? linkURL(safe) : safe;
      }
    : undefined;
  return (
    <Suspense fallback={<PlainText>{children}</PlainText>}>
      <Rendered disallowedElements={["img"]} {...(urlTransform ? { urlTransform, components: { a: PlatformLink } } : {})}>{children}</Rendered>
    </Suspense>
  );
}
