import { writeFile } from "node:fs/promises";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import type { Scene } from "three";
import { projectSlug } from "../src/lib/sections";

declare global {
  interface Window {
    motionTestScene?: Scene;
  }
}

// Tier 4: a robotics builder checks the opposed slides of a gripper in its installed fixture.
test("replay an installed jaw cycle and inspect the modeled checks", async ({ page }, info) => {
  test.setTimeout(120000);
  const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), "jaw-playback");
  const member = { userId: "builder", organizationId: "motion-fixture", role: "member" };
  const origin = "https://workshop.outfitter.example";
  function part(name: string, kind = "assembly") {
    return { id: crypto.randomUUID(), number: name, name, revision: "A", kind };
  }
  function use(itemId: string, position = [0, 0, 0]) {
    return { id: crypto.randomUUID(), quantity: 1, itemId, position };
  }
  function box(origin: number[], size: number[]) {
    return { kind: "box", mode: "add", origin, size };
  }
  async function save(name: string, assembly: unknown) {
    const model = await (await app.call("/api/apps/workshop/projects", member, {
      method: "POST", body: { name, example: "cube" },
    })).json() as { id: string; name: string; revision: number };
    const saved = await app.call("/api/apps/workshop/projects/" + model.id + "/assembly", member, {
      method: "PUT", body: { expectedRevision: model.revision, assembly },
    });
    expect(saved.status, await saved.text()).toBe(200);
    return model;
  }
  try {
    const gripper = part("Parallel gripper"), finger = part("Jaw", "fabricated"), rail = part("Slide rail", "fabricated");
    const left = use(finger.id, [-8, 0, 0]), right = use(finger.id, [8, 0, 0]);
    const leftPath = left.id + "#0", rightPath = right.id + "#0";
    const joint = { kind: "prismatic", axis: [1, 0, 0] };
    const grip = await save("Gripper source", { rootId: gripper.id, items: [
      { ...gripper, uses: [{ ...left, joint }, { ...right, joint }, use(rail.id)],
        couplings: [{ driverPath: leftPath, followerPath: rightPath, ratio: -1 }],
        operations: [{ name: "Jaw cycle", durationSeconds: 2, playback: "loop",
          tracks: [{ path: leftPath, keys: [{time: 0, value: 0}, {time: 1, value: 4}, {time: 2, value: 0}] }] }] },
      { ...rail, color: "#728997", geometry: {version: 1, units: "mm", features: [box([-13, -4, -2], [26, 8, 2])]} },
      { ...finger, color: "#bb693d", geometry: {version: 1, units: "mm", features: [
        box([-2.5, -4, 0], [5, 8, 3]), box([-1.5, -4, 3], [3, 8, 8]),
      ]} },
    ]});
    const fixture = part("Test stand"), mount = part("Installed gripper"), mounted = use(mount.id, [6, 3, 10]);
    const mountPath = mounted.id + "#0";
    const operation = {
      name: "Grip cycle", durationSeconds: 4, tracks: [],
      calls: [{ path: mountPath, operation: "Jaw cycle", startSeconds: 1 }],
      expectations: [
        { label: "Left jaw at closure", time: 2, kind: "position", path: mountPath + "/" + leftPath, expected: [2, 3, 10], tolerance: 0.01 },
        { label: "Right jaw at closure", time: 2, kind: "position", path: mountPath + "/" + rightPath, expected: [10, 3, 10], tolerance: 0.01 },
      ],
    };
    const consumer = await save("Parallel gripper test stand", { rootId: fixture.id, items: [
      { ...fixture, uses: [mounted], operations: [operation, {
        ...operation, name: "Check misaligned stop",
        expectations: [{ ...operation.expectations[0], label: "Left stop target", expected: [3, 3, 10] }],
      }] },
      { ...mount, reference: { projectId: grip.id } },
    ]});
    await page.route(origin + "/**", async route => {
      if (await fulfillPlatformIdentity(route)) return;
      const u = new URL(route.request().url());
      await fulfillFrom(route, await app.call(u.pathname + u.search, member));
    });
    await page.addInitScript(() => {
      const observer = new EventTarget();
      Object.assign(window, { __THREE_DEVTOOLS__: observer });
      observer.addEventListener("observe", event => {
        const scene = (event as CustomEvent).detail as Scene;
        if (scene.isScene) window.motionTestScene = scene;
      });
    });
    await page.setViewportSize({width: 1680, height: 960});
    await page.goto(origin + "/projects/" + projectSlug(consumer));
    await expect(page.locator("#assembly-viewer")).toHaveAttribute("data-ready", "true", {timeout: 60000});
    await page.getByRole("tab", {name:"Components", exact:true}).click();
    // Pan the gripper clear of the controls so both jaws remain visible in the evidence.
    const canvas = await page.locator("#assembly-viewer").boundingBox();
    if (!canvas) throw Error("Missing assembly viewport");
    const x = canvas.x + canvas.width / 2, y = canvas.y + canvas.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x - 160, y, { steps: 6 });
    await page.mouse.up({ button: "right" });
    await page.locator("#motion-menu > summary").click();
    const select = page.getByRole("combobox", {name: "Operation", exact: true});
    await select.selectOption({label: "Test stand · Grip cycle"});
    async function capture(name: string) {
      const view = info.outputPath(name + ".png");
      await page.screenshot({path: view});
      await info.attach(name, {path: view, contentType: "image/png"});
      const motion = page.locator("#motion-menu > summary");
      await motion.click();
      const mechanism = info.outputPath(name + "-mechanism.png");
      await page.locator("#assembly-viewer").screenshot({path: mechanism});
      await info.attach(name + "-mechanism", {path: mechanism, contentType: "image/png"});
      await motion.click();
    }
    await capture("jaw-open");
    await page.getByText("Modeled checks · 2/2 passed").click();
    const rows = page.locator("#operation-check-list li");
    await expect(rows).toHaveCount(2);
    const positions = () => page.evaluate(() => {
      const found: number[][] = [];
      window.motionTestScene?.traverse(node => {
        const rest = node.userData.restMatrix?.elements;
        if (rest?.[14] === 10 && (rest[12] === -2 || rest[12] === 14)) {
          found.push(node.matrix.elements.slice(12, 15));
        }
      });
      return found.sort((a,b) => a[0] - b[0]);
    });
    const rest = await positions();
    expect(rest).toEqual([[-2, 3, 10], [14, 3, 10]]);
    await rows.first().getByRole("button", {name: "View at 2 s"}).click();
    await expect(page.locator("#operation-clock")).toHaveText("2.00 s");
    const closed = await positions();
    expect(closed).toEqual([[2, 3, 10], [10, 3, 10]]);
    const checkResults = await rows.allTextContents();
    await capture("jaw-closure");
    await select.selectOption({label: "Test stand · Check misaligned stop"});
    await page.getByText("Modeled checks · 0/1 passed").click();
    await expect(rows).toContainText("Fail · Left stop target");
    const failure = await rows.first().textContent();

    // Advance the actual player clock beyond one full child cycle. A one-shot would have stopped.
    await select.selectOption({label: "Parallel gripper · Jaw cycle"});
    await expect(page.getByText("Repeats until paused")).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const press = (id: string) => page.locator(id).evaluate((button: HTMLButtonElement) => button.click());
    await press("#operation-play");
    await page.clock.runFor(2500);
    await expect(page.locator("#operation-play")).toHaveText("Pause operation");
    const loopAt = Number(await page.locator("#operation-time").inputValue());
    expect(loopAt).toBeGreaterThan(0.45);
    expect(loopAt).toBeLessThanOrEqual(0.51);
    await press("#operation-play");
    await page.clock.runFor(500);
    expect(Number(await page.locator("#operation-time").inputValue())).toBe(loopAt);
    await press("#operation-reset");
    expect(await positions()).toEqual(rest);

    await select.selectOption({label: "Test stand · Grip cycle"});
    await press("#operation-play");
    await page.clock.runFor(4100);
    await expect(page.locator("#operation-play")).toHaveText("Play operation");
    await expect(page.locator("#operation-clock")).toHaveText("4.00 s");
    await expect(page.locator("#operation-loop")).toBeHidden();
    const report = info.outputPath("motion-checks.json");
    await writeFile(report, JSON.stringify({
      fixture: "Parallel gripper test stand",
      operation: operation.name,
      renderedJawOriginsAtRestMm: rest,
      checks: operation.expectations.map((check, i) => ({
        label: check.label, timeSeconds: check.time, expectedMm: check.expected, renderedMm: closed[i],
        toleranceMm: check.tolerance, panelText: checkResults[i],
      })),
      deliberateMismatchControl: failure,
      loopAfter2_5Seconds: loopAt,
      oneShotFinalSeconds: Number(await page.locator("#operation-time").inputValue()),
    }, null, 2));
    await info.attach("motion-checks", { path: report, contentType: "application/json" });
  } finally {
    await page.unrouteAll({behavior: "ignoreErrors"});
    await app.dispose();
  }
});
