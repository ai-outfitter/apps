import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import {
  fulfillFrom,
  fulfillPlatformIdentity,
} from "@ai-outfitter/app-test/playwright";
for (const width of [390, 1440])
  test(`Presentations shows a downloadable deck at ${width}px`, async ({
    browser,
  }) => {
    const app = await appWorker(
      "presentations",
      appArtifact(new URL("..", import.meta.url), "operational"),
      "review-presentations",
    );
    const id = "abc00000-0000-4000-8000-000000000001";
    await app.database
      .prepare("INSERT INTO creative_media VALUES (?,?,?,1)")
      .bind(
        app.installationId,
        id,
        JSON.stringify({
          id,
          subjectId: "Storyboard:artera-deck",
          filename: "artera-deck.pdf",
          contentType: "application/pdf",
          sha256: "a".repeat(64),
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
      await page.goto(`${app.origin}/artifacts`);
      await expect(
        page.getByRole("heading", { name: "Decks and artifacts", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Download PDF", exact: true }),
      ).toHaveAttribute("href", `./api/media/${id}?download`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`presentations-${width}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
      await app.dispose();
    }
  });
