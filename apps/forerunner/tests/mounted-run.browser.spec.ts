import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";

// A personal install is served at /apps/<slug>/, and its pages see only their
// own path. Anything outside the mount lands on the platform, which 404s here.
const origin = "https://outfitter.example";
const mount = "/apps/forerunner";

test("run tabs stay inside a personal /apps/<slug>/ mount", async ({ page }) => {
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "demo"), "install");
  const outside: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const inner = url.pathname.startsWith(`${mount}/`) ? url.pathname.slice(mount.length) : url.pathname.startsWith("/_astro/") ? url.pathname : null;
    if (inner === null) {
      outside.push(url.pathname);
      return route.fulfill({ status: 404, body: "Not found" });
    }
    await fulfillFrom(route, await app.fetch(`${origin}${inner}${url.search}`, { redirect: "manual" }));
  });
  try {
    await page.goto(`${origin}${mount}/runs/sample/inputs`);
    for (const tab of ["Changes", "Transcript", "Inputs"]) {
      await page.getByRole("navigation", { name: "Run views" }).getByRole("link", { name: new RegExp(`^${tab}`) }).click();
      await expect(page).toHaveURL(`${origin}${mount}/runs/sample/${tab.toLowerCase()}`);
      await expect(page.locator(`#run-tab-${tab.toLowerCase()}`)).toHaveAttribute("aria-current", "page");
    }
    await page.getByRole("link", { name: "← Back to history" }).click();
    await expect(page).toHaveURL(`${origin}${mount}/history`);
    expect(outside).toEqual([]);
  } finally {
    await app.dispose();
  }
});
