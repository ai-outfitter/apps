// Screenshots of Workshop's design workbench, taken by the box after each design
// step, so a run shows what the member would have seen while the model iterated.
// The box image has Chrome (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) and the platform
// checkout has Playwright; without either the box runs on without screenshots.

/** The workbench page for a project: its slug may be just the end of the project ID. */
export const workbenchPath = (project) => `/projects/${String(project.id).slice(-12)}/assembly`;

/** Names a screenshot after its step: "1-design.png", "2-follow-up-1.png", "3-export.png". */
export const screenshotName = (index, step) => `${index}-${step.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;

/**
 * A PNG of the whole page. Workshop's shell is one window tall and its main pane scrolls,
 * so a full-page capture is only the window: the window grows to the pane's whole height
 * first (up to 4000 px), so the screenshot holds the workbench and the whole 3D view.
 * @param {import("playwright-core").Page} page
 */
export async function workbenchScreenshot(page) {
  const width = page.viewportSize()?.width ?? 1440;
  const height = await page.evaluate(() => {
    let hidden = 0;
    for (const element of document.querySelectorAll("*")) {
      const overflow = getComputedStyle(element).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight)
        hidden = Math.max(hidden, element.scrollHeight - element.clientHeight);
    }
    return Math.max(document.documentElement.scrollHeight, window.innerHeight + hidden);
  });
  await page.setViewportSize({ width, height: Math.min(Math.ceil(height), 4000) });
  // The 3D view redraws at its new size.
  await page.waitForTimeout(1000);
  return page.screenshot({ fullPage: true });
}

/**
 * Opens a browser signed in as the box's member, or returns undefined when there is none.
 * @param {any} box the supervisor's driver context
 * @param {string} cookie the member's session cookie ("name=value; ...")
 */
export async function openWorkbench(box, cookie) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    box.log("No screenshots: Playwright is not installed");
    return undefined;
  }
  const origin = `http://workshop.box.outfitter.localhost:${box.port}`;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      // Software WebGL for the 3D view, and the box's hostnames on loopback.
      args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  } catch (error) {
    box.log(`No screenshots: the browser did not start (${error.message})`);
    return undefined;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addCookies(cookie.split("; ").filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
  }));
  return {
    /** A PNG of the project's workbench once its 3D view has drawn, or as it is after two minutes. */
    async capture(project) {
      const page = await context.newPage();
      try {
        const response = await page.goto(`${origin}${workbenchPath(project)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        // A page that did not load has no 3D view to wait for.
        if (!response?.ok()) throw new Error(`the workbench answered ${response?.status() ?? "nothing"}`);
        const ready = await page.locator('#assembly-viewer[data-ready="true"]').waitFor({ state: "attached", timeout: 120_000 })
          .then(() => true, () => false);
        // The frame after the model is added, not the one before.
        await page.waitForTimeout(1000);
        return { png: await workbenchScreenshot(page), ready };
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}
