import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";

const origin = "https://html-starter.alpha.example";
let worker: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  worker = await appWorker(
    "html-starter",
    appArtifact(new URL("..", import.meta.url), "operational"),
  );
});
test.afterAll(async () => {
  await worker?.dispose();
});

test("inspect identity, refresh it, and recover from session expiry and failed authorization", async ({
  page,
}, info) => {
  let status = 200;
  let name = "Test Viewer";
  let fail = false;
  let calls = 0;
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/whoami") {
      calls++;
      if (fail) return route.abort();
      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          user: { name, email: "viewer@example.test" },
          organization: { name: "Alpha", role: "member" },
          installation: { template: "html-starter", mode: "operational" },
        }),
      });
    }
    const response = await worker.call(url.pathname);
    await fulfillFrom(route, response);
  });
  await test.step("the compiled HTML shows the authenticated response", async () => {
    await page.goto(origin);
    await expect(page.getByRole("status")).toHaveText("You are signed in.");
    await expect(page.locator("#user")).toHaveText(
      "Test Viewer (viewer@example.test)",
    );
    await expect(page.locator("#organization")).toHaveText("Alpha · member");
    await page.screenshot({
      path: info.outputPath("html-starter.png"),
      fullPage: true,
    });
  });
  await test.step("refresh updates safely without a navigation", async () => {
    name = '<img src=x onerror="alert(1)">';
    await page.getByRole("button", { name: "Refresh identity" }).click();
    await expect(page.locator("#user")).toHaveText(
      `${name} (viewer@example.test)`,
    );
    await expect(page.locator("#user img")).toHaveCount(0);
    expect(calls).toBe(2);
    expect(page.url()).toBe(`${origin}/`);
  });
  await test.step("expiry offers the normal document login gate", async () => {
    status = 401;
    await page.getByRole("button", { name: "Refresh identity" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Your session has ended",
    );
    await expect(page.locator("#identity")).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Sign in with Outfitter" }),
    ).toHaveAttribute("href", `${origin}/`);
  });
  await test.step("denial and network failure do not keep stale identity", async () => {
    status = 403;
    await page.getByRole("button", { name: "Refresh identity" }).click();
    await expect(page.getByRole("status")).toContainText("do not have access");
    await expect(page.locator("#login")).toBeHidden();
    fail = true;
    await page.getByRole("button", { name: "Refresh identity" }).click();
    await expect(page.getByRole("status")).toContainText("Unable to check");
    await expect(page.locator("#identity")).toBeHidden();
  });
});
