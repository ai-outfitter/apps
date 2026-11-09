import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
const origin = "https://forerunner.example";
test("the demo opens a sample run from History", async ({ page }) => {
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "demo"), "install");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${origin}/**`, async (route) => fulfillFrom(route, await app.fetch(route.request().url())));
  for (const [w, h] of [[1440, 1000], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${origin}/history`);
    await page.getByRole("link", { name: "Open a sample run" }).click();
    await page.getByRole("button", { name: /Re: salon dinner/ }).click();
    await expect(page.locator("#run-mail-detail")).toContainText("cook the pasta course");
  }
  expect(errors).toEqual([]);
  await app.dispose();
});
