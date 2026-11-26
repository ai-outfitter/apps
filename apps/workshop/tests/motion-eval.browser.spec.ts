import { readFile, writeFile } from "node:fs/promises";
import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";
import type { Scene } from "three";
import { Answer, fixtureAssembly, fixtures, type FixtureId } from "../agent-evals/motion/fixtures";
import { projectSlug } from "../src/lib/sections";

const origin = "https://workshop.outfitter.example";
const identity = { userId: "builder", organizationId: "motion-eval", role: "member" as const };

const cases = (Object.keys(fixtures) as FixtureId[]).map((id) => ({
  id, subject: "reference", answer: fixtures[id].reference,
}));
const receiptFile = new URL("../agent-evals/motion/evidence/spark-2026-11-26-r2.json", import.meta.url);
const recordedSpark = JSON.parse(await readFile(receiptFile, "utf8")) as {
  receipts: { inputs: { fixture: string }; grade: { passed: boolean }; output: string }[];
};
const result = recordedSpark.receipts.find((entry) => entry.inputs.fixture === "transfer-rig");
if (!result?.grade.passed) throw Error("Missing passing Spark transfer rig receipt");
cases.push({ id: "transfer-rig", subject: "spark", answer: Answer.parse(JSON.parse(result.output)) });

for (const { id, subject, answer } of cases) {
  test(id + " plays its " + subject + " program in Workshop", async ({ page }, info) => {
    test.setTimeout(120_000);
    const fixture = fixtures[id];
    const { assembly, path } = fixtureAssembly(id, answer, true);
    const app = await appWorker("workshop", appArtifact(new URL("..", import.meta.url), "operational"), id + "-" + subject);
    try {
      const created = await app.call("/api/apps/workshop/projects", identity, {
        method: "POST", body: { name: fixture.title, example: "cube" },
      });
      const model = await created.json() as { id: string; name: string; revision: number };
      const saved = await app.call("/api/apps/workshop/projects/" + model.id + "/assembly", identity, {
        method: "PUT", body: { expectedRevision: model.revision, assembly },
      });
      expect(saved.status, await saved.text()).toBe(200);
      await page.route("**/*", (route) => route.abort());
      await page.route(origin + "/**", async (route) => {
        if (await fulfillPlatformIdentity(route)) return;
        const url = new URL(route.request().url());
        await fulfillFrom(route, await app.call(url.pathname + url.search, identity));
      });
      await page.addInitScript(() => {
        const observer = new EventTarget();
        Object.assign(window, { __THREE_DEVTOOLS__: observer });
        observer.addEventListener("observe", (event) => {
          const scene = (event as CustomEvent<Scene>).detail;
          if (scene.isScene) Object.assign(window, { motionEvalScene: scene });
        });
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(origin + "/projects/" + projectSlug(model));
      const canvas = page.locator("#assembly-viewer");
      await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
      await expect(canvas).not.toHaveAttribute("data-empty", "");
      const motionMenu = page.locator("#motion-menu > summary");
      await motionMenu.click();
      const select = page.getByRole("combobox", { name: "Operation", exact: true });
      await select.selectOption({ label: fixture.title + " · Demonstrate motion" });
      await page.getByText(`Modeled checks · ${fixture.checks.length}/${fixture.checks.length} passed`).click();
      const rows = page.locator("#operation-check-list li");
      await expect(rows).toHaveCount(fixture.checks.length);

      const observations = [];
      for (const [i, check] of fixture.checks.entries()) {
        await rows.nth(i).getByRole("button").click();
        await expect(page.locator("#operation-clock")).toHaveText(check.time.toFixed(2) + " s");
        const actual = await page.evaluate(({ suffix, point }) => {
          let pointMm: number[] | undefined;
          const scene = (window as Window & { motionEvalScene?: Scene }).motionEvalScene;
          scene?.traverse((node) => {
            if (node.userData.path?.endsWith(suffix) && node.visible && node.children.some((child) => child.visible)) {
              const m = node.matrix.elements;
              pointMm = [0, 1, 2].map((i) =>
                m[i] * point[0] + m[i + 4] * point[1] + m[i + 8] * point[2] + m[i + 12]);
            }
          });
          return pointMm;
        }, { suffix: "/" + path(check.part), point: check.point });
        expect(actual, check.label).toBeDefined();
        expect(Math.hypot(...actual!.map((value, j) => value - check.expected[j])), check.label).toBeLessThanOrEqual(0.001);
        observations.push({ label: check.label, timeSeconds: check.time, expectedMm: check.expected, renderedMm: actual });
        const capture = id === "transfer-rig"
          ? [0.5, 2, 4].includes(check.time) && check.part === "payload"
          : i === 0 || i === fixture.checks.length - 1;
        if (capture) {
          await motionMenu.click();
          await page.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }));
          const image = info.outputPath("frame-" + i + ".png");
          await canvas.screenshot({ path: image });
          await info.attach("frame-" + i, { path: image, contentType: "image/png" });
          await motionMenu.click();
        }
      }
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1_000));
      const press = (selector: string) => page.locator(selector).evaluate((button: HTMLButtonElement) => button.click());
      await press("#operation-reset");
      await press("#operation-play");
      await page.clock.runFor(fixture.duration * 1_000 + 500);
      const finalTime = Number(await page.locator("#operation-time").inputValue());
      if (fixture.playback === "loop") {
        await expect(page.locator("#operation-play")).toHaveText("Pause operation");
        expect(finalTime).toBeGreaterThan(0.45);
        expect(finalTime).toBeLessThanOrEqual(0.51);
      } else {
        await expect(page.locator("#operation-play")).toHaveText("Play operation");
        expect(finalTime).toBe(fixture.duration);
      }
      const report = info.outputPath("playback.json");
      await writeFile(report, JSON.stringify({ id, subject, browser: page.context().browser()?.version(),
        toleranceMm: 0.001, playback: fixture.playback, finalTimeSeconds: finalTime, observations }, null, 2) + "\n");
      await info.attach("playback", { path: report, contentType: "application/json" });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await app.dispose();
    }
  });
}
