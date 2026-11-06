import { expectClientNavigation, routeReadOnly, stayOnPage, openAccountMenuFor } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Page, test } from "@playwright/test";

const origin = "https://workshop.outfitter.example";
const project = `${origin}/projects/sensor-mount-study-000000000101`;

// A project page has loaded once its project is shown and its controls are live.
const loaded = (page: Page) =>
  page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>(".workshop .shell");
    return !shell || (!shell.inert && document.querySelector("#project-title")?.textContent === "Sensor mount study");
  });

test("sidebar links swap pages inside the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app, {});
    await expectClientNavigation(page, `${project}/`, ["Project brief", "Design workbench", "Parts & cost", "Assembly & inventory"], () => loaded(page));
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});

test("the 3D preview rebuilds after leaving the project and coming back", async ({ page }) => {
  test.setTimeout(180_000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "demo"));
  const visit = stayOnPage(page);
  try {
    await routeReadOnly(page, origin, app, {});
    await page.goto(`${project}/`);
    await loaded(page);
    await visit.mark();
    const sidebar = page.locator("#sidebar");
    for (const round of [1, 2]) {
      await sidebar.getByRole("link", { name: "Design workbench", exact: true }).click();
      await expect(page.locator("#geometry-status"), `round ${round}`).toContainText("geometry ready", { timeout: 60_000 });
      await sidebar.getByRole("link", { name: "All projects", exact: true }).click();
      await expect(page.locator(".project-row")).toHaveCount(3);
      await openAccountMenuFor(page, "Workshop settings");
      await sidebar.getByRole("link", { name: "Workshop settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Workshop settings", level: 1 })).toBeVisible();
      await sidebar.getByRole("link", { name: "Projects", exact: true }).click();
      await page.getByRole("link", { name: /Sensor mount study/ }).click();
      await loaded(page);
    }
    await visit.expectSame();
    visit.expectNoErrors();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
