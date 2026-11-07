import { expectClientNavigation, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { test } from "@playwright/test";

const origin = "https://creative-team.org.example";

test("sidebar links swap pages inside the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("creative-team", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app);
    await expectClientNavigation(page, `${origin}/`, ["Overview", "Brand", "Content", "Map", "Drafts", "Creative team settings"]);
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await app.dispose();
    }
  }
});
