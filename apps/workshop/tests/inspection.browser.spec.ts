import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { projectSlug } from "../src/lib/sections";

// Tier 4: a sensor builder opens one of two installed covers to inspect a breadboard.
test("inspect one installed cover, restore its pose, and preview the enclosure sizing", async ({ page }) => {
  test.setTimeout(120000);
  const app = await appWorker(
    "workshop",
    appArtifact(new URL("..", import.meta.url), "operational"),
    "inspection",
  );
  const member = { userId: "builder", organizationId: "inspection", role: "member" },
    origin = "https://workshop.outfitter.example";
  try {
    const created = (await (
      await app.call("/api/apps/workshop/projects", member, {
        method: "POST",
        body: { name: "Breadboard enclosure", example: "cube" },
      })
    ).json()) as { id: string; revision: number; name: string };
    const root = crypto.randomUUID(),
      cover = crypto.randomUUID(),
      left = crypto.randomUUID(),
      right = crypto.randomUUID();
    const use = (id: string, x: number, label: string) => ({
      id,
      itemId: cover,
      quantity: 1,
      refdes: label,
      position: [x, 0, 0],
      joint: { kind: "revolute", axis: [0, 1, 0], openDegrees: -95 },
    });
    const assembly = {
      rootId: root,
      power: {
        version: 1,
        notes: "",
        scenarios: [{ name: "Normal", id: "normal", notes: "" }],
        rails: [{ id: "source", name: "DC", voltage: 12, kind: "dc", efficiency: 1, notes: "" }],
      },
      items: [
        {
          id: root,
          name: "Housing",
          number: "H",
          kind: "assembly",
          revision: "A",
          uses: [use(left, 0, "Left"), use(right, 30, "Right")],
        },
        {
          id: cover,
          name: "Lid",
          number: "L",
          kind: "printed",
          revision: "A",
          priceKnown: true,
          unitCost: 2,
          power: {
            loads: [
              {
                id: "lamp",
                name: "Lid light",
                rail: "source",
                evidence: "assumed",
                source: "Fixture",
                notes: "",
                scenarios: { normal: { averageW: 2, operatingW: 2, peakW: 2 } },
              },
            ],
          },
          geometry: {
            version: 1,
            units: "mm",
            features: [{ kind: "box", mode: "add", origin: [0, 0, 0], size: [15, 12, 2] }],
          },
        },
      ],
      configurations: [
        {
          name: "bench",
          rootId: root,
          parameters: [
            {
              name: "spacing",
              min: 20,
              max: 60,
              defaultValue: 30,
              placements: [{ parentId: root, usageId: right, axis: "x", scale: 1, offset: 0 }],
            },
          ],
        },
      ],
    };
    const response = await app.call("/api/apps/workshop/projects/" + created.id + "/assembly", member, {
      method: "PUT",
      body: { expectedRevision: created.revision, assembly },
    });
    expect(response.status).toBe(200);
    const writes: string[] = [];
    await page.route(origin + "/**", async (route) => {
      if (await fulfillPlatformIdentity(route)) return;
      const req = route.request(),
        url = new URL(req.url());
      if (req.method() !== "GET") writes.push(req.url());
      await fulfillFrom(route, await app.call(url.pathname + url.search, member));
    });
    await page.goto(origin + "/projects/" + projectSlug(created));
    const canvas = page.locator("#assembly-viewer");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60000 });
    await page.getByRole("tab", { name: "Sizing" }).click();
    await expect(page.locator("#model-sizing")).toContainText("45 mm");
    await page.getByRole("combobox", { name: "Configuration", exact: true }).selectOption("bench");
    await page.getByLabel("spacing", { exact: true }).fill("50");
    await page.getByRole("button", { name: "Preview configuration" }).click();
    await expect(page).toHaveURL(/configuration=bench/);
    await page.getByRole("tab", { name: "Sizing" }).click();
    await expect(page.locator("#model-sizing")).toContainText("65 mm");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Components" }).click();
    await page.locator("#inspection-tree").getByRole("button", { name: "Lid", exact: true }).click();
    const leftPath = root + "/" + left + "#0";
    await page.getByRole("combobox", { name: "Installed instance" }).selectOption(leftPath);
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60000 });
    const closed = await canvas.screenshot();
    // Reverse during the opening swing. Two animation frames give the hinge time to leave rest.
    await page.getByRole("button", { name: "Open hinge" }).evaluate(async (node) => {
      const button = node as HTMLButtonElement;
      button.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      button.click();
    });
    await expect.poll(async () => (await canvas.screenshot()).equals(closed)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Open hinge" }).click();
    const open = await canvas.screenshot();
    expect(open).not.toEqual(closed);
    await page.getByRole("button", { name: "Close hinge" }).click();
    expect(await canvas.screenshot()).toEqual(closed);
    await page.getByRole("button", { name: "Hide component" }).click();
    expect(await canvas.screenshot()).not.toEqual(closed);
    await page.getByRole("tab", { name: "BOM" }).click();
    await expect(page.locator("#bom-price")).toContainText("$4.00");
    await page.locator("#bom-mode").selectOption("totals");
    await expect(page.locator("#bom-rows")).toContainText("Qty 2");
    await page.getByRole("tab", { name: "Power" }).click();
    await expect(page.locator("#power-summary")).toContainText("4 W simultaneous");
    await page.getByRole("tab", { name: "Selected" }).click();
    await page.getByRole("button", { name: "Restore assembly" }).click();
    expect(await canvas.screenshot()).toEqual(closed);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
