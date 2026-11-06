import { routeReadOnly } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";

const slug = "workshop";
test(`${slug} uses the normal shell with fixture data and no API calls`, async ({
  page,
}) => {
  const worker = await appWorker(
    slug,
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
  const origin = `https://${slug}.outfitter.example`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeReadOnly(page, origin, worker);
  try {
    await page.goto(`${origin}/`);
    await expect(page.locator("body")).not.toContainText(
      /\bdemo\b|\bstaged\b|sample data/i,
    );

    // Home lists every project with its model and manufacturing stage.
    const rows = page.locator(".project-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("SNY-1 soil sensor node");
    await expect(rows.filter({ hasText: "Sensor mount study" }).locator("[aria-current=step]")).toHaveText("Validation");
    await expect(rows.filter({ hasText: "Cable keeper" }).locator("[aria-current=step]")).toHaveText("Manufacturing");
    await expect(page.locator(".project-row[data-thumbnail=ready]")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator("#agent-submit")).toBeDisabled();
    await expect(page.locator("[data-example]").first()).toBeDisabled();

    await page.getByRole("link", { name: /Sensor mount study/ }).click();
    await expect(page).toHaveURL(/\/projects\/sensor-mount-study-000000000101$/);
    await expect(page.locator("#project-title")).toHaveText("Sensor mount study");
    await expect(page.locator("#brief-form input[name=name]")).toBeDisabled();
    await expect(page.locator("#agent-submit")).toBeDisabled();
    await page.locator("#sidebar").getByRole("link", { name: "Parts & cost", exact: true }).click();
    await expect(page.locator("#parts-list")).toContainText(
      "M3 mounting screws",
    );
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await worker.dispose();
  }
});

test(`${slug} shows the whole assembly, its BOM with firmware, and units by MAC address`, async ({ page }) => {
  const worker = await appWorker(slug, appArtifact(new URL("..", import.meta.url), "demo"));
  const origin = `https://${slug}.outfitter.example`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await routeReadOnly(page, origin, worker);
  try {
    await page.goto(`${origin}/`);
    await page.getByRole("link", { name: /SNY-1 soil sensor node/ }).click();
    await expect(page.locator("#project-title")).toHaveText("SNY-1 soil sensor node");
    await page.locator("#sidebar").getByRole("link", { name: "Assembly & inventory", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/sny-1-soil-sensor-node-000000000106\/assembly$/);
    const bom = page.locator("#bom-list tr");
    await expect(bom).toHaveCount(13);
    await expect(page.locator("#bom-list")).toContainText("Electronics sub-assembly");
    await expect(page.locator("#bom-list")).toContainText("ESP32-S3-DevKitC-1-N8R8");
    await expect(page.locator("#bom-list")).toContainText("esp32s3 · v0.1.0");
    await expect(bom.filter({ hasText: "ESP32-S3-DevKitC-1-N8R8" })).toContainText("2 · by MAC");
    await expect(page.locator("#unit-list")).toContainText("34:85:18:7A:10:01");
    await expect(page.locator("#assembly-viewer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(page.locator("#assembly-status")).toContainText("9 solids");
    const shots = process.env.WORKSHOP_SCREENSHOTS;
    if (shots) await page.locator(".assembly-viewer").screenshot({ path: `${shots}/assembly-3d.png` });
    await bom.filter({ hasText: "ESP32-S3-DevKitC-1-N8R8" }).click();
    await expect(bom.filter({ hasText: "ESP32-S3-DevKitC-1-N8R8" })).toHaveClass(/selected/);
    if (shots) {
      await page.waitForTimeout(500);
      await page.locator(".assembly-viewer").screenshot({ path: `${shots}/assembly-3d-esp32.png` });
      await page.locator("table.bom").screenshot({ path: `${shots}/bom.png` });
      await page.locator("#unit-list").screenshot({ path: `${shots}/inventory.png` });
    }
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await worker.dispose();
  }
});
