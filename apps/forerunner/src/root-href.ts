/**
 * The relative prefix that reaches the app root from a page `depth` segments
 * below it: "./" from "/", "/life" or "/apps/<id>/", "../" from "/runs/<id>".
 * A path served with a trailing slash sits one level deeper, so it needs one
 * more "../". Relative links keep the app inside its mount, whether that is
 * its own host, /o/<org>/forerunner/ or a personal /apps/<id>/.
 */
export const rootHref = (pathname: string, depth: number) =>
  "../".repeat(Math.max(0, depth - (pathname.endsWith("/") ? 0 : 1))) || "./";
