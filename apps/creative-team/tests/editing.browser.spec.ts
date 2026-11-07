import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { expect, test } from "@playwright/test";

const origin = "https://creative-team.org.example";
const owner = { userId: "creator", organizationId: "org", role: "owner" };

// The pages' forms save through the app's documents and show the saved records in place,
// never through the client router's own form navigation.
test("an editor answers the interview twice and grows the map from the page", async ({ page }) => {
  test.setTimeout(120_000);
  const app = await appWorker("creative-team", appArtifact(new URL("..", import.meta.url), "operational"), "creative");
  try {
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postData();
      const response = await app.call(url.pathname + url.search, owner, { method: request.method(), ...(body ? { body: JSON.parse(body) } : {}) });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(`${origin}/brand`);
    const answer = page.getByLabel("What results can you point to, for you or for people you've helped?");
    const revision = page.locator("form:has(#q-story\\.results) [name=revision]");
    const save = page.locator("form:has(#q-story\\.results)").getByRole("button", { name: "Save" });
    await answer.fill("Coached 40 nurses back from burnout.");
    await save.click();
    await expect(page.getByText("Answer saved.")).toBeVisible();
    await expect(revision).toHaveValue("1");
    await answer.fill("Coached 41 nurses.");
    await save.click();
    await expect(revision).toHaveValue("2");
    await expect(page).toHaveURL(`${origin}/brand`);

    await page.goto(`${origin}/map`);
    await page.getByLabel("New pillar").fill("Recovering from burnout");
    await page.getByRole("button", { name: "Add pillar" }).click();
    await page.getByPlaceholder("Add a topic").fill("Why rest doesn't feel restful");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Why rest doesn't feel restful")).toBeVisible();
    await expect(page.locator(".map-counts")).toContainText("1 pillar ");
  } finally {
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await app.dispose();
    }
  }
});
