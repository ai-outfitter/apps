import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";

// App tests cover the handoff. Schedule editing and provider authorization are platform tests.
for (const mode of ["demo", "operational"] as const) {
  test(`${mode} management bookmarks leave the app for their platform workspace without enabling work`, async ({ page }) => {
    let hostCalls = 0;
    const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), mode), "forerunner", {
      workflowHost: () => ({ async call() { hostCalls++; return { ok: false as const, status: 400, message: "No workflow calls expected" }; } }),
    });
    const origin = "https://workspace.example";
    const scope = { organizationId: "org", installationId: "forerunner", userId: "alice", packageHash: "test", phase: "interactive" as const, expiresAt: Date.now() + 3600000 };
    const member = { userId: "alice", organizationId: "org", role: "owner" };
    try {
      await page.route(`${origin}/**`, async route => {
        expect(route.request().method()).toBe("GET");
        const url = new URL(route.request().url());
        expect(url.pathname).not.toContain("/api/");
        if (/\/(automations|connections)$/.test(url.pathname)) {
          await route.fulfill({ contentType: "text/html", body: "<h1>Platform management</h1>" }); return;
        }
        const inner = url.pathname.split("/forerunner/")[1] ?? url.pathname.replace(/^\//, "");
        await fulfillFrom(route, await app.call(`/${inner}${url.search}`, member, { headers: { "x-outfitter-page-url": url.href }, workflowHost: scope }));
      });
      for (const prefix of ["", "/o/acme"]) {
        const mount = prefix ? `${prefix}/forerunner` : "/apps/forerunner";
        for (const [path, target] of [["settings", "/automations?view=schedules"], ["workflows", "/automations"], ["sources", "/connections"]]) {
          await page.goto(`${origin}${mount}/${path}`).catch(error => { if (!String(error).includes("ERR_ABORTED")) throw error; });
          await expect(page).toHaveURL(`${origin}${prefix}${target}`);
          await expect(page.getByRole("heading", { name: "Platform management" })).toBeVisible();
        }
      }
      expect(hostCalls).toBe(0);
    } finally { await page.unrouteAll({ behavior: "wait" }); await app.dispose(); }
  });
}
