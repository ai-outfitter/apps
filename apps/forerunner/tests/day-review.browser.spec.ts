import { expect, test } from "@playwright/test";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { pageURLHeader } from "@ai-outfitter/app-sdk/server";
import { reviewPeriod } from "../src/server/review-period";

const origin = "https://outfitter.example", mount = "/apps/forerunner";
const date = "2026-11-10", timezone = "America/Chicago";
const period = reviewPeriod({ date, timezone }, Date.parse("2026-11-11T14:00:00Z"));
const savedReport = { period, status: "incomplete", summary: "One active project report captured; some sources are incomplete.", reference: { slug: "saved-daily-example", revision: 2 }, dependencies: [{ summary: { repositoryEvidence: { repositories: [{ pullRequests: [{ number: 12, title: "Ship the customer onboarding flow", url: "https://github.com/example/product/pull/12", mergedAt: "2026-11-10T18:00:00Z" }] }] } } }] };

for (const width of [1440, 390]) {
  test(`saved daily review and previous-week navigation at ${width}px`, async ({ page }) => {
    const viewer = { userId: "alice", organizationId: "", role: "owner", owner: { kind: "user" as const, id: "alice" } };
    const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), "review-install", {
      workflowHost: () => ({ async call(operation, input) {
        const value = input as Record<string, unknown>;
        if (operation === "entities.types") return { ok: true, value: [{ installationId: "planning", template: "planning", type: "portfolio-priority", collection: "portfolio-priorities", title: "Personal priorities", description: "Saved private order", schema: { type: "object" }, writable: false, operations: ["list", "get"] }] };
        if (operation === "entities.get") return { ok: true, value: { ref: { installationId: "planning", type: "portfolio-priority", id: "organizations" }, revision: 1, title: "Order", attributes: { items: ["northstar", "atlas"] }, references: [] } };
        if (operation === "actions.call") return { ok: true, value: { data: { dailyReport: null } } };
        if (operation !== "platform.document") return { ok: false, status: 400, message: "Read-only review fixture" };
        if (!value.variables) return { ok: true, value: { viewer: { orgs: ["atlas", "northstar"].map(slug => ({ slug, name: slug === "northstar" ? "Northstar" : "Atlas", appSlugs: ["planning"] })) } } };
        const variables = value.variables as { date: string };
        return { ok: true, value: { data: { dailyReports: [{ organizationSlug: (value.scopes as string[])[0], report: variables.date === date ? savedReport : null }] } } };
      } }),
    });
    const scope = { organizationId: null, installationId: app.installationId, userId: "alice", packageHash: "test", phase: "interactive" as const, expiresAt: Date.now() + 120000 };
    const outside: string[] = [];
    await page.route(`${origin}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      const inner = url.pathname.startsWith(`${mount}/`) ? url.pathname.slice(mount.length) : url.pathname.startsWith("/_astro/") ? url.pathname : null;
      if (inner === null) { outside.push(url.pathname); return route.fulfill({ status: 404, body: "Outside app mount" }); }
      const headers = new Headers(request.headers()); headers.set(pageURLHeader, request.url());
      await fulfillFrom(route, await app.call(inner + url.search, viewer, { method: request.method(), headers, workflowHost: scope }));
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}${mount}/yesterday?date=${date}&timezone=${encodeURIComponent(timezone)}`);
      await expect(page.getByRole("heading", { name: "Across your organizations" })).toBeVisible();
      const sources = page.locator(".day-source");
      await expect(sources.nth(0).getByRole("heading")).toHaveText("Northstar");
      await expect(sources.nth(1).getByRole("heading")).toHaveText("Atlas");
      await expect(sources.first().getByText("Incomplete sources", { exact: true })).toBeVisible();
      await expect(sources.first().getByRole("link", { name: "#12 Ship the customer onboarding flow" })).toHaveAttribute("href", "https://github.com/example/product/pull/12");
      await expect(sources.first().getByRole("link", { name: "Read saved report" })).toHaveAttribute("href", "/o/northstar/wiki-map/p/saved-daily-example?revision=2");
      await expect(page.getByText("No board completions were recorded for this day.")).toBeVisible();
      await page.getByRole("link", { name: "Previous week", exact: true }).click();
      await expect(page.getByLabel("Review date", { exact: true })).toHaveValue("2026-11-03");
      await expect(sources.first().getByText("No daily report was saved for this date.")).toBeVisible();
      await expect(sources.first().getByRole("link", { name: "#12 Ship the customer onboarding flow" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(outside).toEqual([]);
    } finally { await app.dispose(); }
  });
}
