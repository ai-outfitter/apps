import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { wikiGraphFixture } from "@ai-outfitter/app-test/wiki-fixture";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, type Page, test } from "@playwright/test";
import { demoGraph } from "../fixtures/demo";

const origin = "https://video-production.alpha.localhost";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const shots = process.env.VIDEO_PRODUCTION_SCREENSHOTS;

/** The operational app over a seeded organization Onto, reached through the platform host. */
async function seeded(page: Page) {
  const reads: string[] = [];
  const app = await appWorker("video-production", appArtifact(new URL("..", import.meta.url), "operational"), "video-production", {
    workflowHost: () => ({
      async call(operation, raw) {
        if (operation === "entities.types") {
          const template = (raw as { template?: string } | undefined)?.template;
          return { ok: true, value: template && template !== "onto" ? [] : ["graph-type", "graph-node", "graph-edge"].map((type, i) => ({
            installationId: "onto", type, template: "onto", slug: "onto", collection: ["types", "nodes", "edges"][i], title: type, description: "fixture", schema: {}, writable: true,
          })) };
        }
        if (operation === "actions.call") {
          reads.push(String((raw as { action: string }).action));
          return { ok: true, value: wikiGraphFixture("onto", demoGraph) };
        }
        throw new Error(`Unexpected host call ${operation}`);
      },
    }),
  });
  await page.route(`${origin}/**`, async (route) => {
    if (await fulfillPlatformIdentity(route)) return;
    const request = route.request();
    expect(request.method()).toBe("GET");
    await fulfillFrom(route, await app.dispatch("", new Request(request.url(), {
      headers: { ...request.headers(), "x-outfitter-user": owner.userId, "x-outfitter-organization": owner.organizationId, "x-outfitter-installation": app.installationId, "x-outfitter-role": owner.role },
    }), { workflowHost: { ...owner, installationId: app.installationId, packageHash: "fixture", phase: "interactive", expiresAt: Date.now() + 3_600_000 } }));
  });
  return { app, reads };
}

for (const width of [1280, 390])
  test(`storyboards from the organization's Onto, by brief, then one storyboard's shots in order at ${width}px`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const { app, reads } = await seeded(page);
    try {
      await page.goto(`${origin}/`);
      const brief = page.locator("section.brief", { has: page.getByRole("heading", { name: "Sunny app launch" }) });
      await expect(brief).toContainText("For Sunny plant placement planner");
      await expect(brief.getByRole("link")).toHaveText(["Find your spot", "Find your spot, short cut"]);
      await expect(brief.locator("li").first()).toContainText("15s · 9:16 · Social · 4 shots · 2 waiting on references · draft");
      if (shots) await page.screenshot({ path: `${shots}/video-production-storyboards-${width}.png`, fullPage: true });

      await brief.getByRole("link", { name: "Find your spot", exact: true }).click();
      await expect(page).toHaveURL(`${origin}/storyboards/find-your-spot`);
      await expect(page.getByRole("heading", { name: "Find your spot", level: 1 })).toBeVisible();
      // Client-side navigation cross-fades; let it finish before reading or capturing the page.
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
      const items = page.locator("ol.shots > li");
      await expect(items.locator("strong")).toHaveText(["Choose a place", "Scan the room", "The best spot lights up", "Plant in place"]);
      await expect(items.nth(0)).toContainText("hook · at 0s · 3s");
      await expect(items.nth(0)).toContainText("“Where will it grow best?”");
      await expect(items.nth(0)).toContainText("Needs SNY-1 visual lock");
      await expect(items.nth(1)).toContainText("blocked");
      await expect(items.nth(1)).toContainText("Needs Planner light map screen (no file yet)");
      await expect(page.locator("ul.references > li")).toHaveCount(2);
      await expect(page.locator("ul.references")).toContainText("requirement, no file yet");
      await expect(page.getByRole("link", { name: "Sunny app launch" })).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/video-production-storyboard-${width}.png`, fullPage: true });
      expect(reads.every((action) => action === "graph.read")).toBe(true);

      const missing = await app.call("/storyboards/no-such-board", owner, { workflowHost: { ...owner, installationId: app.installationId, packageHash: "fixture", phase: "interactive", expiresAt: Date.now() + 3_600_000 } });
      expect(missing.status).toBe(404);
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await context.close();
        await app.dispose();
      }
    }
  });
