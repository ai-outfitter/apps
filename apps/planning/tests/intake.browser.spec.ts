import { test, expect, type Route } from "@playwright/test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
for (const width of [1440, 390])
  test(`capture and inspect governed intake at ${width}px`, async ({
    page,
  }, info) => {
    const app = await appWorker(
      "planning",
      appArtifact(new URL("..", import.meta.url), "operational"),
    );
    const rows: {
      id: string;
      revision: number;
      body: {
        input: { title: string; description: string };
        routes: unknown[];
      };
    }[] = [];
    async function fixtureAction(route: Route) {
      const request = route.request();
      const { action, input } = request.postDataJSON();
      if (action === "intake.list") return route.fulfill({ json: rows });
      if (action === "intake.get")
        return route.fulfill({
          json: rows.find((row) => row.id === input.intakeId),
        });
      if (action === "intake.options")
        return route.fulfill({ json: { gates: [] } });
      if (action === "intake.create") {
        rows.push({ id: input.requestId, revision: 1, body: { input, routes: [] } });
        // The CreateIntake document answers the intake flat, with its routes.
        return route.fulfill({
          json: {
            ...input,
            id: input.requestId,
            revision: 1,
            routes: [],
            routingError: "Choose an active control before work can start",
          },
        });
      }
      return route.fulfill({ status: 409, body: "Active control required" });
    }
    await page.route("https://planning.alpha.localhost/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === "/api/apps/planning")
        return route.fulfill({ json: { projects: [] } });
      if (path === "/api/apps/planning/use-cases/context")
        return route.fulfill({
          json: { installationId: "wiki", hostname: "wiki.alpha.localhost" },
        });
      if (path === "/api/apps/planning/work") return fixtureAction(route);
      return fulfillFrom(route, await app.fetch(request.url()));
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("https://planning.alpha.localhost/intake");
      await page
        .getByLabel("Title", { exact: true })
        .fill("Customers abandon booking");
      await page
        .getByLabel("Description", { exact: true })
        .fill("Compare competitors and identify the smallest useful change.");
      await page
        .getByLabel("Source URLs", { exact: true })
        .fill("https://example.test/competitor");
      await page
        .getByRole("button", { name: "Submit intake", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Customers abandon booking" }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Choose an active control" }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Customers abandon booking" }),
      ).toBeVisible();
      await page.getByText("Full intake and evidence", { exact: true }).click();
      await expect(
        page.getByRole("link", {
          name: "https://example.test/competitor",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `/tmp/governed-intake-${width}.png`,
        fullPage: true,
      });
      await page.screenshot({
        path: info.outputPath(`governed-intake-${width}.png`),
        fullPage: true,
      });
    } finally {
      await app.dispose();
    }
  });
