import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { fulfillFrom, fulfillPlatformIdentity, isPlatformIdentityRequest } from "@ai-outfitter/app-test/playwright";
import { identityHeaderValues, pageURLHeader } from "@ai-outfitter/app-sdk/server";

const origin = "https://wiki.example", platform = "https://platform.example";
for (const width of [1440, 390]) test(`personal Wiki retains its platform rail and account footer at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
  const mount = "/apps/wiki-map/", who = { userId: "editor", organizationId: "", owner: { kind: "user" as const, id: "editor" }, role: "owner" };
  let accountsReads = 0;
  try {
    await app.call("/api/apps/wiki-map/documents", who, { method: "POST", body: { operation: "SaveDocument", variables: { input: { title: "Project notebook", body: "Private synthetic notes", slug: "project-notebook" } } } });
    await page.route(`${origin}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("/api/accounts")) { accountsReads++; await route.fulfill({ json: { accounts: [] } }); return; }
      if (url.pathname.endsWith("/api/whoami")) { await route.fulfill({ json: { user: { id: "editor", name: "Fixture member", email: "member@example.test" } } }); return; }
      if (isPlatformIdentityRequest(url)) { await fulfillPlatformIdentity(route); return; }
      const path = url.pathname.startsWith(mount) ? url.pathname.slice(mount.length) : url.pathname.slice(1);
      const headers = new Headers(request.headers());
      for (const [key, value] of Object.entries(identityHeaderValues({ ...who, installationId: app.installationId }))) headers.set(key, value);
      headers.set(pageURLHeader, request.url());
      const response = await app.dispatch("", new Request(`${origin}/${path}${url.search}`, { method: request.method(), headers, body: request.postData() }));
      if (!response.headers.get("content-type")?.includes("text/html")) { await fulfillFrom(route, response); return; }
      const html = (await response.text()).replace("</head>", `<meta name="outfitter-apps" content="${platform}/apps"><meta name="outfitter-personal-navigation" content="wiki"></head>`);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: html });
    });
    await page.goto(`${origin}${mount}`);
    const rail = page.getByRole("navigation", { name: "Personal", exact: true });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("link")).toHaveCount(6);
    await expect(rail.getByRole("link", { name: "Wiki", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(rail.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", `${platform}/`);
    const account = page.getByRole("button", { name: "Accounts", exact: true });
    await expect(account).toBeVisible();
    await expect(page.locator(".personal-rail [data-account-footer]")).toHaveCount(1);
    if (width < 760) {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
      await expect(rail).toBeVisible();
    }
    await account.click();
    if (width < 760) await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(page.getByRole("link", { name: "Manage accounts", exact: true })).toHaveAttribute("href", `${platform}/accounts`);
    const menu = await page.locator("#account-menu").boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape"); await expect(account).toBeFocused();
    await page.evaluate(() => { (window as any).retainedAccount = document.querySelector("[data-account-footer]"); });
    await page.getByRole("link", { name: "Project notebook", exact: true }).click();
    await expect(page.getByRole("article")).toContainText("Private synthetic notes");
    await expect(account).toBeVisible();
    expect(await page.evaluate(() => (window as any).retainedAccount === document.querySelector("[data-account-footer]"))).toBe(true);
    await expect(rail.getByRole("link", { name: "Wiki", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
    await page.screenshot({ path: `test-results/personal-wiki-rail-${width}.png`, fullPage: true });
    // A later organization/legacy page must remove personal destinations and return its account footer.
    await page.evaluate(() => {
      document.dispatchEvent(new Event("astro:before-swap"));
      document.querySelector('meta[name="outfitter-personal-navigation"]')?.remove();
      document.dispatchEvent(new Event("astro:after-swap")); document.dispatchEvent(new Event("astro:page-load"));
    });
    await expect(rail).toBeHidden();
    await expect(page.locator(".personal-rail a[href]")).toHaveCount(0);
    await expect(page.locator("#sidebar [data-account-footer]")).toHaveCount(1);
    expect(accountsReads).toBe(0);
  } finally { await app.dispose(); }
});

test("organization Wiki never shows the personal rail without explicit personal metadata", async ({ page }) => {
  const app = await appWorker("wiki-map", new URL("../.outfitter/packages/operational.json", import.meta.url));
  const who = { userId: "editor", organizationId: "org", role: "owner" }, mount = "/o/example/wiki-map/";
  try {
    await page.route(`${origin}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      if (isPlatformIdentityRequest(url)) { await fulfillPlatformIdentity(route); return; }
      const headers = new Headers(request.headers());
      for (const [key, value] of Object.entries(identityHeaderValues({ ...who, installationId: app.installationId }))) headers.set(key, value);
      headers.set(pageURLHeader, request.url());
      const path = url.pathname.startsWith(mount) ? url.pathname.slice(mount.length) : url.pathname.slice(1);
      const response = await app.dispatch("", new Request(`${origin}/${path}${url.search}`, { method: request.method(), headers, body: request.postData() }));
      if (!response.headers.get("content-type")?.includes("text/html")) { await fulfillFrom(route, response); return; }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: (await response.text()).replace("</head>", `<meta name="outfitter-apps" content="${platform}/apps"></head>`) });
    });
    await page.goto(`${origin}${mount}`);
    await expect(page.locator(".personal-rail")).toBeHidden();
    await expect(page.locator(".personal-rail a[href]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Outfitter", exact: true })).toHaveAttribute("href", `${platform}/apps`);
    await expect(page.locator("#sidebar [data-account-footer]")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await app.dispose(); }
});
