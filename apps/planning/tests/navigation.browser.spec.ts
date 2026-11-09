import { expectClientNavigation, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { test } from "@playwright/test";

const origin = "https://planning.example";

test("sidebar links swap pages inside the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("planning", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app, {});
    await expectClientNavigation(page, `${origin}/`, ["Operations", "Projects", "Products", "Opportunities", "Use cases", "Customer segments", "Product"],
      () => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]')));
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await app.dispose();
    }
  }
});
