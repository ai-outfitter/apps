import { expectClientNavigation, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { test } from "@playwright/test";

const origin = "https://hr.outfitter.example";

// Pages render from fixtures on the server and their scripts run synchronously,
// so there is nothing to wait for after a swap.
test("sidebar links swap pages inside the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("hr", appArtifact(new URL("..", import.meta.url), "demo"));
  try {
    await routeReadOnly(page, origin, app, {});
    await expectClientNavigation(page, `${origin}/`, ["TA Dashboard", "Roles", "Hiring plan", "Automated jobs", "Screeners", "Conversations", "Talent Acquisition settings"]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
