import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import {
  fulfillFrom,
  fulfillPlatformIdentity,
} from "@ai-outfitter/app-test/playwright";
for (const width of [390, 1440])
  test(`Marketing renders storyboard review and navigation at ${width}px`, async ({
    browser,
  }) => {
    const app = await appWorker(
      "marketing",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "review-marketing",
    );
    const id = "abc00000-0000-4000-8000-000000000001";
    await app.database
      .prepare("INSERT INTO planning_video_productions VALUES (?,?,1,?,1,1)")
      .bind(
        id,
        app.installationId,
        JSON.stringify({
          title: "Artera launch concept",
          message: "Plants from Earth to orbit",
          audience: "Researchers",
          style: "Photorealistic",
          concept: true,
          channel: "internal",
          shots: [
            {
              id: "research",
              title: "Research on Earth",
              duration: 5,
              narration: "Fresh food begins here",
              prompt: "Growth chamber in an Earth laboratory",
            },
          ],
        }),
      )
      .run();
    const context = await browser.newContext({
        viewport: { width, height: 900 },
      }),
      page = await context.newPage();
    try {
      await context.route(`${app.origin}/**`, async (route) => {
        if (await fulfillPlatformIdentity(route)) return;
        const url = new URL(route.request().url());
        await fulfillFrom(
          route,
          await app.call(url.pathname + url.search, {
            userId: "owner",
            organizationId: "artera",
            role: "owner",
          }),
        );
      });
      await page.goto(`${app.origin}/videos/${id}`);
      await expect(
        page.getByRole("heading", {
          name: "Artera launch concept",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Storyboard", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Concept preview", { exact: false }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`marketing-${width}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
      await app.dispose();
    }
  });
