import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { readerFixture, readerId } from "../fixtures/node-reader";
const identity = {
  userId: "reader-owner",
  organizationId: "reader-org",
  role: "owner",
};
const origin = "https://wiki.outfitter.example";
test("read a control's identity, measurement and missing data without opening its technical specification", async ({
  page,
}, info) => {
  const app = await appWorker(
    "onto",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
  try {
    const initialized = await app.call(
      "/api/internal/app-initialize",
      identity,
      { method: "POST", body: {} },
    );
    expect(initialized.status).toBe(200);
    const graph = readerFixture();
    const rows = [
      ...graph.types.map((attributes) => ({ type: "graph-type", attributes })),
      ...graph.nodes.map((attributes) => ({ type: "graph-node", attributes })),
      ...graph.edges.map((attributes) => ({ type: "graph-edge", attributes })),
    ];
    const applied = await app.call("/api/internal/actions/v1/call", identity, {
      method: "POST",
      body: {
        action: "graph.apply",
        input: {
          requestKey: "reader",
          operations: rows.map((row, i) => ({
            ...row,
            attributes: Object.fromEntries(
              Object.entries(row.attributes).filter(
                ([key]) =>
                  ![
                    "revision",
                    "seedVersion",
                    "createdBy",
                    "updatedBy",
                    "createdAt",
                    "updatedAt",
                    "source",
                  ].includes(key),
              ),
            ),
            operation: "create",
            ref: `$row${i}`,
          })),
        },
      },
    });
    expect(applied.status, await applied.text()).toBe(200);
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      await fulfillFrom(
        route,
        await app.call(url.pathname + url.search, identity, {
          method: request.method(),
          ...(request.postData() ? { body: request.postDataJSON() } : {}),
        }),
      );
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/example-controls/${readerId(3)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "PostHog issue response",
      );
      await expect(page.locator(".node-eyebrow")).toContainText(
        "Control definition",
      );
      await expect(page.locator(".node-eyebrow")).toContainText("Draft");
      await expect(page.locator(".node-readiness")).toContainText(
        "Data source not configured",
      );
      await expect(
        page.getByRole("link", { name: "Alex Morgan", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".node-type-label")).toContainText("Person");
      await expect(page.locator(".node-code")).toHaveCount(0);
      expect(
        await page.evaluate(() => {
          const content = document.querySelector(".app-shell-content");
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            (!content || content.scrollWidth <= content.clientWidth + 1)
          );
        }),
      ).toBe(true);
      await info.attach(`overview-${width}`, {
        body: await page.screenshot({
          path: info.outputPath(`overview-${width}.png`),
          fullPage: true,
        }),
        contentType: "image/png",
      });
      await page.getByRole("tab", { name: "Measurement", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "How it is measured" }),
      ).toBeVisible();
      await expect(page.locator(".node-expression").first()).toContainText(
        "First qualifying response",
      );
      await expect(
        page.getByRole("cell", { name: "Breached", exact: true }),
      ).toBeVisible();
      await info.attach(`measurement-${width}`, {
        body: await page.screenshot({
          path: info.outputPath(`measurement-${width}.png`),
          fullPage: true,
        }),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "Review requirements" }).click();
      await expect(
        page.getByRole("tab", { name: "Data & evidence" }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("heading", { name: "Required inputs" }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "Technical", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Copy definition" }),
      ).toBeVisible();
      await expect(page.locator(".node-code").first()).toContainText(
        '"programs"',
      );
    }
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Overview", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Measurement", exact: true }),
    ).toBeFocused();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("link", { name: "Alex Morgan", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Alex Morgan",
    );
    await expect(page.locator(".node-eyebrow")).toContainText("Person");
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
