import { test, expect } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { routeReadOnly } from "@ai-outfitter/app-test/playwright";
const packageDirectory = new URL("..", import.meta.url);
let worker: Awaited<ReturnType<typeof appWorker>>;
test.beforeAll(async () => {
  worker = await appWorker("hr", appArtifact(packageDirectory, "demo"));
});
test.afterAll(async () => {
  await worker?.dispose();
});
const origin = "https://hr.outfitter.example";
test("the package answers health, refuses writes and sends its policy", async () => {
  const health = await worker.fetch(`${origin}/__health`);
  expect(await health.json()).toEqual({ app: "hr", status: "ok" });
  const page = await worker.fetch(`${origin}/`);
  expect(page.headers.get("content-security-policy")).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  for (const path of ["/", "/api/roles"]) {
    const write = await worker.fetch(`${origin}${path}`, { method: "POST" });
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");
  }
});
const links = [
  "TA Dashboard",
  "Roles",
  "Hiring plan",
  "Automated jobs",
  "Screeners",
  "Conversations",
];
// Links and separators are flex items spaced by the gap, not concatenated text.
async function expectSeparatedBreadcrumb(
  page: import("@playwright/test").Page,
  label: string,
) {
  const crumbs = await page
    .locator(".builder-breadcrumb > *")
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().toJSON()),
    );
  expect(crumbs.length).toBe(5);
  for (const [index, crumb] of crumbs.slice(1).entries())
    if (Math.abs(crumb.top - crumbs[index].top) < 1)
      expect(crumb.left - crumbs[index].right, label).toBeGreaterThanOrEqual(7);
}

async function expectNavigation(page: import("@playwright/test").Page) {
  const navigationLinks = page
    .getByRole("navigation", { name: "App navigation" })
    .getByRole("link");
  await expect(navigationLinks).toHaveCount(links.length);
  for (let i = 0; i < links.length; i++)
    await expect(navigationLinks.nth(i)).toHaveAccessibleName(links[i]);
}
test.beforeEach(async ({ page }) => {
  await routeReadOnly(page, origin, worker);
});
test("role fixtures use the normal builder with read-only fields and navigation", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/roles`);
  await expectNavigation(page);
  await expect(
    page.getByLabel("Working title or role description"),
  ).toBeDisabled();
  await page.goto(`${origin}/roles/agentic-engineer/builder`);
  await expect(page.getByRole("log")).toContainText("Kaizen");
  await expect(page.getByLabel("Problem it solves")).toHaveValue(
    /agent tooling reliable/,
  );
  await expect(page.getByLabel("Problem it solves")).toBeDisabled();
  await expect(
    page.getByLabel("Message Kaizen", { exact: true }),
  ).toBeDisabled();
  await expect(page.locator("body")).not.toContainText(
    /\bdemo\b|\bstaged\b|sample data/i,
  );
  await page.screenshot({
    path: info.outputPath("builder-desktop.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Mission", { exact: true })).toHaveValue(
    /dependable collaborators/,
  );
  await expect(page.getByLabel("Mission", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Draft MOC" })).toBeDisabled();
  await page.getByRole("button", { name: /6\. Approval/ }).click();
  await expect(
    page.getByRole("button", { name: "Send for approval" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /7\. Post in Ashby/ }).click();
  await expect(page.locator("#publication-status")).toContainText(
    "Not published",
  );
  await page.goto(`${origin}/conversations`);
  await expect(
    page.getByRole("link", { name: /Agentic Engineer/ }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("screener fixtures are visible without enabling candidate changes", async ({
  page,
}, info) => {
  await page.goto(`${origin}/screeners`);
  await expect(
    page.getByRole("row", { name: /Agentic Engineer/ }),
  ).toContainText("Review required");
  await expect(
    page.getByRole("row", { name: /Senior Recruiter/ }),
  ).toContainText("Criteria not set");
  await page.goto(`${origin}/screeners/agentic-engineer`);
  await expect(page.locator("#criteria-summary")).toContainText(
    "agent reliability",
  );
  await expect(
    page.getByRole("button", { name: "Screen candidates" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Draft from the job posting" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Armed", { exact: true })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText(
    /\bdemo\b|\bstaged\b|sample data/i,
  );
  await page.screenshot({
    path: info.outputPath("screener-desktop.png"),
    fullPage: true,
  });
});
test("all pages render on desktop and mobile with the exact navigation and no page overflow", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const pages = [
    ["/", "TA Dashboard"],
    ["/roles", "Roles"],
    ["/roles/agentic-engineer", "Member of Technical Staff, Agentic Engineer"],
    ["/roles/agentic-engineer/builder", "Role builder"],
    ["/plan", "Hiring plan"],
    ["/automations", "Automated jobs"],
    ["/screeners", "Screeners"],
    [
      "/screeners/agentic-engineer",
      "Member of Technical Staff, Agentic Engineer",
    ],
    ["/conversations", "Conversations"],
    ["/settings", "Talent Acquisition settings"],
  ];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [path, title] of pages) {
      await page.goto(origin + path);
      const heading = page.getByRole("heading", {
        name: title,
        exact: true,
        level: 1,
      });
      if (path.endsWith("/builder")) {
        await expect(heading).toBeAttached();
        await expect(page.locator(".intro")).toHaveClass(/visually-hidden/);
        expect(
          (await page.locator(".intro").boundingBox())?.width,
        ).toBeLessThanOrEqual(1);
        await expect(
          page.getByRole("navigation", { name: "Breadcrumb" }),
        ).toBeVisible();
        await expect(
          page.getByText("Build role", { exact: true }),
        ).toBeVisible();
        await expectSeparatedBreadcrumb(page, `${path} at ${width}`);
      } else {
        await expect(heading).toBeVisible();
      }
      await expect(page.locator("body")).not.toContainText(
        /\bdemo\b|\bstaged\b|sample data/i,
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      if (overflow) {
        await page.screenshot({
          path: info.outputPath("overflow.png"),
          fullPage: true,
        });
        console.log(
          await page.evaluate(() =>
            Array.from(document.querySelectorAll("*"))
              .filter(
                (el) =>
                  el.getBoundingClientRect().right > innerWidth &&
                  !el.closest(".scroll-table"),
              )
              .map((el) => ({
                tag: el.tagName,
                cls: el.className,
                width: el.getBoundingClientRect().width,
                text: el.textContent?.slice(0, 40),
              })),
          ),
        );
      }
      expect(overflow, `${path} at ${width}`).toBe(false);
      if (width !== 320)
        await page.screenshot({
          path: info.outputPath(
            `${path.replaceAll("/", "-") || "dashboard"}-${width}.png`,
          ),
          fullPage: true,
        });
    }
    if (width < 800) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expectNavigation(page);
      await page.getByRole("link", { name: "Roles", exact: true }).click();
      await expect(
        page.getByRole("navigation", { name: "App navigation" }),
      ).toBeHidden();
    }
  }
  expect(errors).toEqual([]);
});
test("plan navigation works, role fixtures stay read-only, and unknown roles are 404", async ({
  page,
}) => {
  await page.goto(`${origin}/plan`);
  await page.getByRole("button", { name: /My roles/ }).click();
  await expect(page.locator("[data-plan-row]:visible")).toHaveCount(6);
  await page.getByRole("button", { name: "Later ›" }).click();
  await expect(page.locator("#plan-range")).toHaveText("Sep 2026 to Feb 2027");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator("#plan-range")).toHaveText("Aug 2026 to Jan 2027");
  await page.goto(`${origin}/roles/agentic-engineer`);
  const priority = page.getByLabel("Priority", { exact: true });
  const value = await priority.inputValue();
  await expect(priority).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Priority", { exact: true })).toHaveValue(value);
  const response = await worker.fetch(`${origin}/roles/missing`);
  expect(response.status).toBe(404);
});
