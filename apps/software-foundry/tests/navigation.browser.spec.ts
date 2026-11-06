import { expectClientNavigation, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";

const origin = "https://software-foundry.outfitter.example";

test("sidebar links swap pages inside the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("software-foundry", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app);
    const settled = () => page.waitForFunction(() => {
      const pending = [...document.querySelectorAll('.ui-content [role="status"], #issue-count, #repository-summary, #draft-summary')]
        .some((node) => /Loading|Checking/.test(node.textContent ?? ""));
      return !pending && document.querySelector(".app-header .header-muted > span")?.textContent !== "Loading project…";
    });
    await expectClientNavigation(page, `${origin}/`, ["Dashboard", "Issues", "Milestones", "Jobs", "Workflows", "Governance", "Software Foundry settings"], settled);

    // The Workflows page has its own header title and no project panel.
    const sidebar = page.locator("#sidebar");
    const title = page.locator(".header-title");
    await sidebar.getByRole("link", { name: "Workflows", exact: true }).click();
    await expect(title).toHaveText("SF / Workflows");
    await expect(page.locator(".project-panel")).toBeHidden();
    await sidebar.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(title).toHaveText("SF / NORTHSTAR");
    await expect(page.locator(".project-panel")).toBeVisible();
    await expect(page.locator("#project-milestones a").first()).toBeVisible();
    // Between project pages the header keeps the project title a script set.
    await page.locator("[data-project-title]").evaluate((span) => { span.dataset.kept = ""; });
    await sidebar.getByRole("link", { name: "Issues", exact: true }).click();
    await expect(page.locator("[data-project-title][data-kept]")).toHaveText("NORTHSTAR");
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await app.dispose();
    }
  }
});
