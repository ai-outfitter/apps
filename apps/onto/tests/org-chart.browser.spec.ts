import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { expect, test } from "@playwright/test";
import { chartFixture, chartId } from "./fixtures/org-chart";

test("read the board, executive team and direct reports, then open a position", async ({ page }, testInfo) => {
  const { graph, organization } = chartFixture();
  const app = await appWorker("wiki-map", appArtifact(new URL("..", import.meta.url), "operational"));
  const origin = "https://wiki.example";
  try {
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/graph/snapshot")) { await route.fulfill({ json: graph }); return; }
      await fulfillFrom(route, await app.call(url.pathname, { userId: "owner", organizationId: "org", role: "owner" }));
    });
    await page.goto(`${origin}/organizations/${organization.id}/org-chart`);
    await expect(page.getByRole("heading", { name: "Organization chart", exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "3 role assignments" })).toBeVisible();
    const svg = page.locator(".knowledge-graph-viewport svg");
    await expect(svg.locator('a').filter({ hasText: "Board of directors" })).toBeVisible();
    await expect(svg.locator('a').filter({ hasText: "Engineer — Engineering lead" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("org-chart-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("org-chart-mobile.png"), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await svg.locator(`a[data-graph-node="${chartId(4)}"]`).click();
    await expect(page.getByRole("heading", { name: "Engineer assignment", exact: true })).toBeVisible();
  } finally { await app.dispose(); }
});
