import { type BrowserContext, type Page, type Route, defineConfig, expect } from "@playwright/test";
import { platformIdentityResponse } from "./platform-identity";

/** Paths resolve relative to the app's own Playwright configuration. */
export function appPlaywrightConfig() {
  return defineConfig({
    testDir: "./tests",
    testMatch: "**/*.browser.spec.ts",
    outputDir: "./test-results",
    workers: 1,
    reporter: "list",
    use: {
      trace: "retain-on-failure",
      launchOptions: {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      },
    },
  });
}

/** Answer a routed browser request with a Worker response, byte for byte. */
export async function fulfillFrom(route: Route, response: Response) {
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  });
}

type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> };

export { isPlatformIdentityRequest, testMember } from "./platform-identity";
import { isPlatformIdentityRequest } from "./platform-identity";

/** Answers the platform's identity routes at `origin` ahead of routes registered earlier. */
export function routePlatformIdentity(target: Page | BrowserContext, origin: string) {
  return target.route((url) => url.origin === new URL(origin).origin && isPlatformIdentityRequest(url), fulfillPlatformIdentity);
}

/** Answers a page's request to the platform's identity routes as the platform would; false for any other request. */
export async function fulfillPlatformIdentity(route: Route) {
  const response = platformIdentityResponse(route.request().method(), route.request().url());
  if (response) await fulfillFrom(route, response);
  return Boolean(response);
}

/** Demo mode is read-only fixtures: serve `origin` from the Worker and fail
 * any non-GET or `/api/` request the page makes but the platform's identity routes. */
export function routeReadOnly(target: Page | BrowserContext, origin: string, worker: Fetcher, init?: RequestInit) {
  return target.route(`${origin}/**`, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("GET");
    const identity = platformIdentityResponse(request.method(), request.url());
    if (identity) return fulfillFrom(route, identity);
    expect(new URL(request.url()).pathname.startsWith("/api/")).toBe(false);
    await fulfillFrom(route, await worker.fetch(request.url(), init));
  });
}

/**
 * Proves later steps stay on one loaded page: `mark()` tags the window after
 * a load, `expectSame()` fails if a reload dropped the tag, and
 * `expectNoErrors()` fails on any page error since the call.
 */
export function stayOnPage(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    mark: () => page.evaluate(() => Object.assign(window, { __outfitterNavigation: true })),
    expectSame: async (message = "the page reloaded") =>
      expect(await page.evaluate(() => "__outfitterNavigation" in window), message).toBe(true),
    expectNoErrors: () => expect(errors, "page errors").toEqual([]),
  };
}

/** Opens the sidebar's account menu when the link `name` is one of its entries, such as the app's settings. */
export async function openAccountMenuFor(page: Page, name: string) {
  const sidebar = page.locator("#sidebar");
  if (await sidebar.locator("#account-menu").getByRole("link", { name, exact: true, includeHidden: true }).count() === 0) return;
  const toggle = sidebar.getByRole("button", { name: "Accounts", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

/**
 * Sidebar links must swap pages inside the app shell: no reload, the same
 * content as loading the page directly, the link marked current and no page
 * errors. Visits every link twice, in order and then in reverse, since a
 * page's scripts run only once and each page must survive any previous one.
 */
export async function expectClientNavigation(page: Page, start: string, links: string[], settle: () => Promise<unknown> = async () => {}) {
  const sidebar = page.locator("#sidebar");
  const content = page.locator(".ui-content");
  const visit = stayOnPage(page);
  await page.goto(start);
  const hrefs = new Map<string, string>();
  for (const name of links) {
    // includeHidden: an entry of the closed account menu, such as the app's settings.
    const href = await sidebar.getByRole("link", { name, exact: true, includeHidden: true }).getAttribute("href");
    hrefs.set(name, new URL(href ?? "", start).href);
  }
  const direct = new Map<string, string>();
  for (const [name, href] of hrefs) {
    await page.goto(href);
    await settle();
    direct.set(name, await content.innerText());
  }
  await page.goto(start);
  await visit.mark();
  for (const [round, order] of [["forward", links], ["reverse", [...links].reverse()]] as const)
    for (const name of order) {
      const link = sidebar.getByRole("link", { name, exact: true, includeHidden: true });
      await openAccountMenuFor(page, name);
      await link.click();
      // Pages may add query parameters after loading, so compare paths.
      await expect.poll(() => new URL(page.url()).pathname, { message: `${round}: ${name}` }).toBe(new URL(hrefs.get(name) ?? "").pathname);
      await expect(link, `${round}: ${name} is current`).toHaveAttribute("aria-current", "page");
      await settle();
      await expect(content, `${round}: ${name} matches a direct load`).toHaveText(direct.get(name) ?? "", { useInnerText: true });
      await visit.expectSame(`${round}: ${name} reloaded the page`);
    }
  visit.expectNoErrors();
}
