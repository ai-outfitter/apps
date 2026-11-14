import { expect, type Page, test } from "@playwright/test";
import { commitment, signal, stone } from "../src/fixtures";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom, isPlatformIdentityRequest } from "@ai-outfitter/app-test/playwright";
let worker: Awaited<ReturnType<typeof appWorker>>;
let unexpectedRequests: string[] = [];
let failures: string[] = [];
const origin = "https://forerunner.outfitter.example";
const launch = stone("stone.self-serve-launch");
const renewal = stone("stone.brightwater-renewal");
const hiring = stone("stone.platform-lead");

test.beforeAll(async () => {
  worker = await appWorker(
    "forerunner",
    appArtifact(new URL("..", import.meta.url), "demo"),
  );
});
test.afterAll(async () => {
  await worker?.dispose();
});

test.beforeEach(async ({ page }) => {
  unexpectedRequests = [];
  failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  // CSP violations, including a blocked hydration script, are console errors.
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("request", (request) => {
    if (
      request.method() !== "GET" ||
      (new URL(request.url()).pathname.startsWith("/api/") && !isPlatformIdentityRequest(request.url()))
    )
      unexpectedRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route(`${origin}/**`, async (route) => {
    const response = await worker.fetch(route.request().url(), {
      redirect: "manual",
    });
    await fulfillFrom(route, response);
  });
});
test.afterEach(async ({ page }) => {
  expect(unexpectedRequests).toEqual([]);
  expect(failures).toEqual([]);
  // Demo data never lands in browser storage.
  if (page.url().startsWith(origin))
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
});

const detail = (page: Page, id: string) => page.locator(`[id="detail-${id}"]`);
const toggle = (page: Page) =>
  page.getByRole("button", { name: "Ask Forerunner" });
const panel = (page: Page) =>
  page.getByRole("complementary", { name: "Forerunner chat" });

test("priorities stay usable without overflow on desktop and phones", async ({
  page,
}, info) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, title] of [
      ["/priorities", "Today's priorities"],
    ]) {
      await page.goto(origin + path);
      await expect(
        page.getByRole("heading", { name: title, level: 1 }),
      ).toBeVisible();
      if (path === "/priorities") {
        await expect(page.locator(".forerunner-section")).toHaveCount(3);
        for (const [name, count] of [
          ["Stones", 3],
          ["Pebbles", 6],
          ["Sand", 5],
        ] as const) {
          const section = page.getByRole("region", { name });
          await expect(section.locator(".forerunner-card")).toHaveCount(count);
          await expect(section.locator(".forerunner-card time")).toHaveCount(
            count,
          );
          await expect(section.locator(".forerunner-priority")).toHaveCount(
            count,
          );
        }
      }
      if (path === "/priorities" && width !== 320)
        await page.screenshot({
          path: info.outputPath(`forerunner-day-${width}.png`),
          fullPage: true,
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        `${path} at ${width}`,
      ).toBe(false);
    }
  }

});

test("selecting a stone shows its linked signal, commitment, blocker and decision", async ({
  page,
}) => {
  await page.goto(`${origin}/priorities`);
  await expect(detail(page, launch.id)).toBeHidden();
  await page
    .locator(`.forerunner-stone-cards a[data-priority-link="${renewal.id}"]`)
    .click();
  await expect(page).toHaveURL(`${origin}/priorities?priority=${renewal.id}`);
  const shown = detail(page, renewal.id);
  await expect(shown).toBeVisible();
  await expect(detail(page, launch.id)).toBeHidden();
  await expect(shown.getByRole("heading", { level: 3 })).toBeFocused();
  await expect(
    page.locator(`a[data-priority-link="${renewal.id}"][aria-current="true"]`),
  ).toHaveCount(1);
  await expect(
    shown.locator(`[data-record="${renewal.signal}"]`),
  ).toContainText(signal(renewal.signal).subject);
  await expect(
    shown.locator(`[data-record="${renewal.commitment}"]`),
  ).toContainText(commitment(renewal.commitment).title);
  await expect(shown).toContainText(renewal.blocker.summary);
  await expect(
    shown.locator(`[data-record="${renewal.decision.id}"]`),
  ).toContainText(renewal.decision.question);
  await expect(
    shown.getByRole("button", { name: "Record decision" }),
  ).toBeDisabled();
  for (const item of [...renewal.pebbles, ...renewal.sand])
    await expect(
      page.locator(`.forerunner-card[data-record="${item.id}"]`),
    ).toContainText(item.title);

  // A Pebble links back to its Stone; history restores the earlier one.
  await page
    .locator(`.forerunner-card[data-record="${hiring.pebbles[0].id}"]`)
    .click();
  await expect(detail(page, hiring.id)).toBeVisible();
  await page.goBack();
  await expect(detail(page, renewal.id)).toBeVisible();
  await expect(detail(page, hiring.id)).toBeHidden();

  // A deep link renders the same selection on the server, before any script.
  await page.goto(`${origin}/priorities?priority=${hiring.id}`);
  await expect(detail(page, hiring.id)).toBeVisible();
  await expect(detail(page, launch.id)).toBeHidden();

  // A bad deep-link value uses the first stone both on load and on Back.
  await page.goto(`${origin}/priorities?priority=unknown`);
  await expect(detail(page, launch.id)).toBeHidden();
  await page
    .locator(`.forerunner-stone-cards a[data-priority-link="${renewal.id}"]`)
    .click();
  await page.goBack();
  await expect(detail(page, launch.id)).toBeHidden();
  await expect(detail(page, renewal.id)).toBeHidden();

  await page.goto(`${origin}/priorities`);
  await page
    .locator(`.forerunner-card[data-record="${renewal.sand[0].id}"]`)
    .click();
  await expect(detail(page, renewal.id)).toBeVisible();
  await page.getByRole("link", { name: "Close details" }).click();
  await expect(detail(page, renewal.id)).toBeHidden();
  await expect(page).toHaveURL(`${origin}/priorities`);
});

test("the agent panel follows the selected stone with scripted, read-only dialogue", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/priorities?priority=${renewal.id}`);
  await expect(toggle(page)).toBeEnabled();
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page).locator(".agent-sidebar-focus")).toContainText(
    renewal.title,
  );
  await expect(panel(page)).toContainText(renewal.dialogue.briefing);
  await expect(panel(page).getByRole("alert")).toContainText(
    "Scripted preview",
  );

  const [draft] = renewal.dialogue.suggestions;
  await panel(page).getByRole("button", { name: draft.prompt }).click();
  await expect(panel(page)).toContainText(draft.reply);
  await expect(
    panel(page).getByRole("button", { name: draft.prompt }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("forerunner-agent-desktop.png"),
  });

  // Free text gets no invented answer, and the draft stays.
  const box = panel(page).getByRole("textbox", { name: "Message Forerunner" });
  await box.fill("Email Priya that we accept");
  await panel(page).getByRole("button", { name: "Send to Forerunner" }).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "only the suggested questions",
  );
  await expect(box).toHaveValue("Email Priya that we accept");

  // Selection keeps an unsent draft and requires an explicit rescope or discard.
  await page
    .locator(`.forerunner-stone-cards a[data-priority-link="${launch.id}"]`)
    .click();
  await expect(panel(page).locator(".agent-sidebar-focus")).toContainText(
    launch.title,
  );
  await expect(panel(page)).toContainText(launch.dialogue.briefing);
  await expect(panel(page)).not.toContainText(draft.reply);
  await expect(box).toHaveValue("Email Priya that we accept");
  await expect(panel(page)).toContainText("This draft was written for");
  await panel(page).getByRole("button", { name: "Discard draft" }).click();
  await expect(box).toHaveValue("");
  await expect(panel(page).getByRole("alert")).toContainText(
    "Scripted preview",
  );

  await box.focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toBeFocused();
});

test("on a phone the agent panel covers the page, which goes inert until it closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/priorities`);
  await toggle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator(".app-main")).toHaveJSProperty("inert", true);
  await expect(panel(page)).toContainText(launch.dialogue.briefing);
  await panel(page)
    .getByRole("button", { name: "Close Forerunner chat" })
    .click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator(".app-main")).toHaveJSProperty("inert", false);
  await expect(toggle(page)).toBeFocused();
});

test("the Worker refuses writes and pages connect only to their own origin", async () => {
  // Astro's origin check refuses a cross-site POST first (403); a same-origin one reaches the middleware.
  // Astro 7.4 lets a request with no Origin header through to the middleware, so name the other site.
  expect((await worker.fetch(`${origin}/priorities`, { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status).toBe(
    403,
  );
  const write = await worker.fetch(`${origin}/priorities`, {
    method: "POST",
    headers: { Origin: origin },
  });
  expect(write.status).toBe(405);
  expect(write.headers.get("allow")).toBe("GET, HEAD");
  const page = await worker.fetch(`${origin}/priorities`);
  expect(page.headers.get("content-security-policy")).toMatch(
    /connect-src 'self'.*form-action 'none'/,
  );
});
