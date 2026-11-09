import { fulfillFrom, routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";

for (const width of [1440, 390])
  // Wiki, Governance and Foundry check their own sidebars in their own repositories.
  for (const slug of ["planning"]) {
    test(`${slug} opens its private app assistant at ${width}px`, async ({
      page,
    }, info) => {
      const app = await appWorker(
        slug,
        appArtifact(new URL("..", import.meta.url), "operational"),
      );
      const origin = `https://${slug}.alpha.localhost`;
      let reads = 0;
      let recovered = false;
      const proposalId = "11111111-1111-4111-8111-222222222222";
      const unresolved = () =>
        recovered
          ? []
          : [
              {
                id: proposalId,
                threadId: "legacy:deleted",
                revision: 1,
                action: "fixture.apply",
                targetId: proposalId,
                targetRevision: 1,
                changes: { value: "Reviewed request" },
                before: {},
                status: "uncertain",
                recovery: "same-request",
                receipt: { outcome: "unconfirmed" },
              },
            ];
      await page.route(`${origin}/**`, async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (path === `/api/apps/${slug}/agent/context`) {
          reads++;
          return route.fulfill({
            json: {
              type: `${slug}.conversation`,
              context: {
                type: `${slug}.page`,
                id: "11111111-1111-4111-8111-111111111111",
              },
              actions: [],
              privateOnly: true,
              unresolved: unresolved(),
            },
          });
        }
        if (
          path === `/api/apps/${slug}/agent/proposals/${proposalId}/approve`
        ) {
          expect(request.method()).toBe("POST");
          expect(request.postDataJSON()).toEqual({ revision: 1 });
          recovered = true;
          return route.fulfill({
            json: {
              proposal: { id: proposalId, status: "applied" },
              receipt: { confirmed: true },
            },
          });
        }
        if (path.startsWith("/api/platform/threads"))
          return route.fulfill({ json: { thread: null, entries: [], before: null } });
        if (path === `/api/apps/${slug}` && slug === "planning")
          return route.fulfill({ json: { projects: [] } });
        if (path === "/api/apps/planning/work")
          return route.fulfill({
            json:
              request.postDataJSON().action === "intake.options"
                ? { gates: [] }
                : [],
          });
        return fulfillFrom(route, await app.fetch(request.url()));
      });
      try {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${origin}${slug === "planning" ? "/intake" : "/"}`);
        await page.locator("[data-agent-sidebar-toggle]").click();
        const panel = page.locator(`#${slug}-agent`);
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("textbox")).toBeVisible();
        await expect(
          panel.getByLabel(
            "Share with the organization (cannot be changed later)",
          ),
        ).toHaveCount(0);
        await expect(
          panel.getByRole("heading", {
            name: "Unresolved actions",
            exact: true,
          }),
        ).toBeVisible();
        await panel
          .getByRole("button", { name: "Recover result", exact: true })
          .click();
        await expect(
          panel.getByText("Unresolved actions", { exact: true }),
        ).toHaveCount(0);
        if (width >= 768) await expect(panel.getByRole("textbox")).toBeFocused();
        else await expect(panel.getByRole("textbox")).not.toBeFocused();
        expect(recovered).toBe(true);
        expect(reads).toBeGreaterThan(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`${slug}-assistant-${width}.png`),
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
      } finally {
        await app.dispose();
      }
    });
    test(`${slug} demo assistant sends only scripted replies at ${width}px`, async ({
      page,
    }, info) => {
      const app = await appWorker(
        slug,
        appArtifact(new URL("..", import.meta.url), "demo"),
      );
      const origin = `https://${slug}.alpha.localhost`;
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await routeReadOnly(page, origin, app);
      try {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${origin}${slug === "planning" ? "/intake" : "/"}`);
        await page.locator("[data-agent-sidebar-toggle]").click();
        const panel = page.locator(`#${slug}-agent`);
        await expect(panel.getByText(/read-only demo/i)).toBeVisible();
        await panel.getByRole("textbox").fill("What can I review here?");
        await panel.getByRole("textbox").press("Enter");
        await expect(
          panel.getByText(/No inference ran and no records changed/),
        ).toBeVisible();
        expect(errors).toEqual([]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`${slug}-demo-assistant-${width}.png`),
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
      } finally {
        await app.dispose();
      }
    });
  }
