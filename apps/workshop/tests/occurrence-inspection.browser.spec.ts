import { randomUUID } from "node:crypto";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { boxPlan } from "../src/model/cad-plan";
import { projectSlug } from "../src/lib/sections";

const origin = "https://workshop.outfitter.example";

// Tier 2: a field researcher inspects two copies of a remotely defined cartridge.
test("mounted occurrence routes restore the recorded camera, selection, range and focus", async ({ page }) => {
  test.setTimeout(120000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), "field");
  const member = { userId: "researcher", organizationId: "field", role: "member" };
  const prefix = "/o/field/workshop";
  const item = (id: string, name: string) => ({ id, name, number: name, revision: "A", kind: "assembly" });
  const use = (id: string, itemId: string) => ({ id, itemId, quantity: 1 });
  const newProject = async (name: string) => {
    const result = await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { name, example: "cube" } });
    expect(result.status).toBe(201);
    return await result.json() as { id: string; revision: number; name: string };
  };
  const save = async (project: Awaited<ReturnType<typeof newProject>>, assembly: unknown) => {
    const result = await app.call("/api/apps/workshop/projects/" + project.id + "/assembly", member, {
      method: "PUT", body: { expectedRevision: project.revision, assembly },
    });
    expect(result.status, await result.text()).toBe(200);
  };

  try {
    const source = await newProject("Cartridge source");
    const [sourceRoot, sensor, battery, sensorUse, batteryUse] = Array.from({ length: 5 }, () => randomUUID());
    await save(source, { rootId: sourceRoot, items: [
      { ...item(sourceRoot, "Cartridge"), uses: [use(sensorUse, sensor), use(batteryUse, battery)] },
      { ...item(sensor, "Sensor"), kind: "cots", geometry: boxPlan(12, 10, 8) },
      { ...item(battery, "Battery"), kind: "cots", geometry: boxPlan(8, 9, 10) },
    ] });
    const product = await newProject("Field sensor");
    const [root, betaRoot, linked, cartridges, betaUsage] = Array.from({ length: 5 }, () => randomUUID());
    await save(product, {
      rootId: root,
      configurations: [
        { name: "alpha", rootId: root, parameters: [{
          name: "cartridgeHeight", defaultValue: 5, min: 0, max: 100,
          placements: [{ parentId: root, usageId: cartridges, axis: "z", scale: 1, offset: 0 }],
        }] },
        { name: "beta", rootId: betaRoot },
      ],
      items: [
        { ...item(root, "Field rig"), uses: [{ ...use(cartridges, linked), quantity: 2, orientation: [40, 10, 0] }] },
        { ...item(betaRoot, "Bench rig"), uses: [use(betaUsage, linked)] },
        { ...item(linked, "Installed cartridge"), reference: { projectId: source.id } },
      ],
    });

    const writes: string[] = [];
    const documents: string[] = [];
    await page.route(origin + "/**", async route => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== "GET") writes.push(request.method() + " " + url.pathname);
      if (request.isNavigationRequest()) documents.push(url.pathname);
      const workerPath = url.pathname.startsWith(prefix + "/") ? url.pathname.slice(prefix.length) : url.pathname;
      await fulfillFrom(route, await app.call(workerPath + url.search, member));
    });
    const productPath = "/projects/" + projectSlug(product);
    const rootUrl = origin + prefix + productPath + "?configuration=alpha";
    const canonical = productPath + "/assembly/" + cartridges + "~1";
    const direct = await app.call(canonical + "?configuration=alpha", member);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain("Cartridge");
    expect((await app.call(canonical + "?configuration=beta", member)).status).toBe(404);
    expect((await app.call(canonical.replace("~1", "~2") + "?configuration=alpha", member)).status).toBe(404);
    expect((await app.call(canonical + "/" + sensorUse + "~0?configuration=alpha", member)).status).toBe(404);
    expect((await app.call("/projects/" + projectSlug(source) + "/assembly/" + cartridges + "~1", member)).status).toBe(404);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(rootUrl);
    const viewer = page.locator("#assembly-viewer");
    const ready = async () => {
      await expect(viewer).toHaveAttribute("data-ready", "true", { timeout: 60000 });
      await expect(viewer).not.toHaveAttribute("data-empty");
    };
    const heading = page.locator("#project-name");
    const range = page.getByRole("slider", { name: "Explode amount" });
    const second = page.getByRole("link", { name: "Cartridge · copy 2", exact: true });
    await ready();
    await expect(page.locator("#level-meta")).toContainText("Installed: alpha");
    await page.getByRole("tab", { name: "Parameters and source" }).click();
    await expect(page.locator("#source-record")).toContainText("Cartridge Height");
    await expect(page.locator("#source-record")).toContainText("Default 5");
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByRole("link", { name: "Cartridge · copy 1", exact: true })).toHaveAttribute("tabindex", "0");
    await page.getByRole("button", { name: "Explode 0%" }).click();
    await range.press("End");
    await expect(range).toHaveValue("100");
    await expect(page.locator("#explode-mode")).toContainText("World Z");
    await second.focus();
    await second.press("Enter");


    await expect(page).toHaveURL(url => url.pathname === prefix + canonical && url.searchParams.get("explode") === "100");
    await ready();
    await expect(heading).toBeFocused();
    await expect(heading).toHaveText("Cartridge · copy 2");
    await expect(page.locator("#product-identity")).toHaveText("Field sensor");
    await expect(page.locator("#occurrence-list [role=listitem]")).toHaveCount(2);
    expect(documents).toContain(prefix + canonical);
    await range.press("PageDown");
    const lidRange = await range.inputValue();
    const sensorRow = page.getByRole("link", { name: "Sensor", exact: true });
    await heading.press("ArrowDown");
    await expect(sensorRow).toBeFocused();
    await sensorRow.press("Enter");
    await expect(page.locator("#selected-name")).toHaveText("Sensor");
    await sensorRow.press("ArrowDown");
    const batteryRow = page.getByRole("link", { name: "Battery", exact: true });
    await expect(batteryRow).toBeFocused();
    await batteryRow.press("Enter");
    await expect(page.locator("#selected-name")).toHaveText("Battery");
    await page.goBack();
    await expect(page.locator("#selected-name")).toHaveText("Sensor");
    await page.goForward();
    await expect(page.locator("#selected-name")).toHaveText("Battery");

    await viewer.focus();
    await viewer.press("ArrowRight");
    await viewer.press("+");
    const before = await page.evaluate(() => {
      const key = history.state.workshopEntry;
      return JSON.parse(sessionStorage.getItem("workshop:inspection:" + key)!).camera;
    });
    const lid = page.url();
    const ancestor = page.getByRole("navigation", { name: "Assembly hierarchy" }).getByRole("link", { name: "Field rig" });
    const ancestorHref = await ancestor.getAttribute("href");
    await ancestor.click();
    await expect(heading).toHaveText("Field rig");
    await expect(page).toHaveURL(ancestorHref!);
    await page.goBack();
    await expect(page).toHaveURL(lid);
    await ready();
    await expect(ancestor).toBeFocused();
    await expect(range).toHaveValue(lidRange);
    await expect(page.locator("#selected-name")).toHaveText("Battery");
    const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem("workshop:inspection:" + history.state.workshopEntry)!).camera);
    for (const key of ["position", "target"]) {
      for (let axis = 0; axis < 3; axis++) expect(after[key][axis]).toBeCloseTo(before[key][axis], 9);
    }
    await page.goForward();
    await expect(page).toHaveURL(ancestorHref!);
    await expect(heading).toHaveText("Field rig");

    await page.goto(lid);
    await page.reload();
    await ready();
    await expect(heading).toHaveText("Cartridge · copy 2");
    await expect(page.locator("#selected-name")).toHaveText("Battery");
    await page.getByRole("tab", { name: "Parameters and source" }).click();
    await expect(page.getByRole("link", { name: "Cartridge source", exact: true })).toBeVisible();
    await expect(page.locator("#source-record")).toContainText("No parameter values are recorded for this source.");
    await page.goto(rootUrl + "&inspect=" + encodeURIComponent(root + "/" + cartridges + "#0"));
    await expect(page).toHaveURL(url => url.pathname.endsWith("/" + cartridges + "~0"));
    await expect(heading).toHaveText("Cartridge · copy 1");
    await page.goto(origin + prefix + productPath + "/assembly/" + betaUsage + "~0?configuration=beta");
    await ready();
    await expect(heading).toHaveText("Cartridge");
    await expect(page.locator("#level-meta")).toContainText("Installed: beta");
    await expect(page.getByRole("link", { name: "Bench rig", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(writes).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
