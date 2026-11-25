import { randomUUID } from "node:crypto";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import { projectSlug } from "../src/lib/sections";
import { boxPlan } from "../src/model/cad-plan";

const origin = "https://workshop.outfitter.example";

test("a field researcher revisits the exact installed cartridge in the originating product", async ({ page }) => {
  test.setTimeout(120000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), "field");
  const member = { userId: "researcher", organizationId: "field", role: "member" };
  const prefix = "/o/field/apps/workshop";
  const newProject = async (name: string) => {
    const response = await app.call("/api/apps/workshop/projects", member, { method: "POST", body: { name, example: "cube" } });
    expect(response.ok).toBe(true);
    return response.json() as Promise<{ id: string; revision: number; name: string }>;
  };
  const save = async (project: Awaited<ReturnType<typeof newProject>>, assembly: unknown) => {
    const response = await app.call("/api/apps/workshop/projects/" + project.id + "/assembly", member, {
      method: "PUT", body: { expectedRevision: project.revision, assembly },
    });
    expect(response.ok, await response.text()).toBe(true);
  };
  try {
    const source = await newProject("Field sensor library");
    const project = await newProject("Field sensor product");
    const [root, bench, mounted, unit, sensor, repeated, second, leaf, shell, shellUse] = Array.from({ length: 10 }, () => randomUUID());
    const item = (id: string, name: string) => ({ id, name, number: name, revision: "A", kind: "assembly" });
    const use = (id: string, itemId: string, quantity = 1) => ({ id, itemId, quantity });
    await save(source, { rootId: unit, items: [
      { ...item(unit, "Cartridge"), uses: [use(leaf, sensor), use(shellUse, shell)] },
      { ...item(sensor, "Sensor PCB"), kind: "pcb", geometry: boxPlan(16, 24, 32) },
      { ...item(shell, "Shell"), kind: "printed", geometry: boxPlan(32, 14, 18) },
    ] });
    await save(project, { rootId: root, items: [
      { ...item(root, "PCB rig"), uses: [{ ...use(repeated, mounted, 2), position: [-20, 0, 0] }] },
      { ...item(bench, "Bench rig"), uses: [{ ...use(second, mounted), orientation: [90, 0, 0] }] },
      { ...item(mounted, "Installed cartridge"), reference: { projectId: source.id } },
    ], configurations: [{ name: "pcb", rootId: root }, { name: "bench", rootId: bench }] });
    const appPath = "/projects/" + projectSlug(project);
    const regular = origin + prefix + appPath;
    const local = appPath + "/inspect/" + repeated + "~1";
    const deep = origin + prefix + local;
    const ssr = await app.call(local + "?configuration=pcb", member);
    expect(ssr.status).toBe(200);
    expect(await ssr.text()).toContain('id="project-name" tabindex="-1">Cartridge');
    expect((await app.call(local + "?configuration=bench", member)).status).toBe(404);
    expect((await app.call(appPath + "/inspect/" + repeated + "~2?configuration=pcb", member)).status).toBe(404);
    expect((await app.call(local + "/" + leaf + "~0?configuration=pcb", member)).status).toBe(404);

    const documents: string[] = [];
    await page.route(origin + "/**", async route => {
      if (await fulfillPlatformIdentity(route)) return;
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest()) documents.push(url.pathname);
      if (url.pathname.startsWith("/api/apps/workshop/")) throw Error("Workshop record request bypassed the app mount");
      expect(request.method()).toBe("GET");
      await fulfillFrom(route, await app.call(url.pathname.replace(new RegExp("^" + prefix), "") + url.search, member));
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(regular + "?configuration=pcb&explode=60");
    const canvas = page.locator("#assembly-viewer");
    const ready = () => expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60000 });
    await ready();
    const range = page.getByRole("slider", { name: /Explode amount/ });
    await expect(range).toHaveValue("60");
    const secondCopy = page.getByRole("treeitem", { name: "Cartridge · 2", exact: true });
    await secondCopy.focus();
    await secondCopy.press("Shift+Enter");
    await expect(page).toHaveURL(deep + "?configuration=pcb&explode=60");
    await ready();
    await expect(secondCopy).toHaveAttribute("aria-current", "location");
    await expect(page.locator("#inspection-product")).toHaveText("Field sensor product");
    await expect(page.locator("#selected-name")).toHaveText("Cartridge");
    await expect(page.getByRole("treeitem", { name: "Cartridge · 1", exact: true })).toBeVisible();
    await expect(range).toHaveValue("60");
    await range.focus();
    await range.press("End");
    await expect(range).toHaveValue("100");
    const sensorRow = page.getByRole("treeitem", { name: "Sensor PCB", exact: true });
    await sensorRow.focus();
    await sensorRow.press("Enter");
    await expect(sensorRow).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#selected-name")).toHaveText("Sensor PCB");
    const selectionURL = page.url();
    const position = () => page.evaluate(() => (history.state.workshopInspection.camera.position as number[]).map(value => Number(value.toFixed(6))));
    const beforeOrbit = await position();
    await canvas.focus();
    await canvas.press("ArrowLeft");
    await expect.poll(position).not.toEqual(beforeOrbit);
    const savedPose = await position();
    const pcb = page.getByRole("navigation", { name: "Assembly hierarchy" }).getByRole("link", { name: "PCB rig" });
    await pcb.focus();
    await pcb.click();
    await expect(page).toHaveURL(regular + "?configuration=pcb&explode=100");
    await ready();
    const parentPose = await position();
    expect(parentPose).not.toEqual(savedPose);

    await page.goBack();
    await ready();
    await expect(page).toHaveURL(selectionURL);
    await expect(range).toHaveValue("100");
    await expect(sensorRow).toHaveAttribute("aria-selected", "true");
    await expect(pcb).toBeFocused();
    await expect.poll(position).toEqual(savedPose);
    await page.goForward();
    await ready();
    await expect(page).toHaveURL(regular + "?configuration=pcb&explode=100");
    await expect(page.locator("#project-name")).toHaveText("PCB rig");
    await expect.poll(position).toEqual(parentPose);
    const reloaded = await page.goto(selectionURL);
    expect(reloaded?.status()).toBe(200);
    await ready();
    await expect(page.locator("#project-name")).toHaveText("Cartridge");
    await expect(sensorRow).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await ready();
    await expect(sensorRow).toHaveAttribute("aria-selected", "true");
    expect(documents).toContain(prefix + local);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(regular + "?configuration=pcb&inspect=" + encodeURIComponent(root + "/" + repeated + "#1") + "&explode=50");
    await ready();
    await expect(page.locator("#project-name")).toHaveText("Cartridge");
    await expect(range).toHaveValue("50");
    const openTree = page.getByRole("button", { name: "Assembly tree", exact: true });
    await openTree.click();
    await expect(page.getByRole("dialog", { name: "Assembly tree" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Find components" }).fill("Sensor PCB");
    await expect(sensorRow).toHaveCount(2);
    expect((await sensorRow.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await expect(openTree).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto(origin + prefix + appPath + "/inspect/" + second + "~0?configuration=bench");
    await ready();
    await expect(page.locator("#occurrence-meta")).toContainText("Installed variant: bench");
    await expect(page.getByRole("link", { name: "Bench rig", exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await app.dispose();
  }
});
