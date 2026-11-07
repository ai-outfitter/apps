/**
 * The relative prefix that reaches the app root from a page `depth` segments below it:
 * "./" from "/" or "/brand", "../" from "/brand/". Relative links keep the app inside its
 * mount, whether that is its own host, /o/<org>/creative-team/ or a personal /apps/<slug>/.
 */
export const rootHref = (pathname: string, depth: number) =>
  "../".repeat(Math.max(0, depth - (pathname.endsWith("/") ? 0 : 1))) || "./";
