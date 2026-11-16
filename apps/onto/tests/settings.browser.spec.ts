import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { expect, test } from "@playwright/test";
import { appWorker } from "./fixtures/initialized-worker";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };

test("an admin chooses on Settings whether the steward approves what it found clean", async ({ page }) => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async () => { throw new Error("Unexpected host call"); } }),
  });
  try {
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/platform/threads") return route.fulfill({ json: { thread: null, entries: [], before: null } });
      await fulfillFrom(route, await app.call(url.pathname + url.search, owner, {
        method: request.method(), ...(request.postData() ? { body: request.postDataJSON() } : {}),
      }));
    });
    await page.goto(`${origin}/settings`);
    const approve = page.getByRole("radio", { name: /Approve what it found clean/ });
    const review = page.getByRole("radio", { name: /Only review/ });
    await expect(approve).toBeChecked();
    await review.check();
    await expect(review).toBeEnabled();
    await page.reload();
    await expect(review).toBeChecked();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
