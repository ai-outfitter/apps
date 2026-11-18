import { expectClientNavigation, fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { type Page, test } from "@playwright/test";

const origin = "https://forerunner.outfitter.example";
const links = ["Today", "Life", "History"];

for (const mode of ["demo", "operational"] as const)
  test(`sidebar links swap ${mode} pages inside the app shell`, async ({ page }) => {
    test.setTimeout(120_000);
    const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), mode), "install");
    try {
      await page.route(`${origin}/**`, async (route) => {
        const request = route.request();
        await fulfillFrom(route, await app.fetch(request.url(), {
          method: request.method(),
          headers: {
            ...request.headers(),
            "x-outfitter-user": "alice",
            "x-outfitter-organization": "org",
            "x-outfitter-installation": "install",
            "x-outfitter-role": "member",
          },
          body: request.postData() ?? undefined,
          redirect: "manual",
        }));
      });
      await expectClientNavigation(page, `${origin}/`, links, () => loaded(page, mode));
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
      } finally {
        await app.dispose();
      }
    }
  });

// Demo pages finish on arrival; operational pages finish their first read. A
// member cannot read discovery, so those pages settle on its error instead.
function loaded(page: Page, mode: "demo" | "operational") {
  if (mode === "demo") return Promise.resolve();
  return page.waitForFunction(() => {
    const board = document.getElementById("board-loading");
    if (board && !board.hidden) return false;
    for (const id of ["discovery-error", "entities-error", "settings-error", "sources-error", "today-error", "workflows-error"]) {
      const error = document.getElementById(id);
      if (error && !error.hidden) return true;
    }
    return ![...document.querySelectorAll(".ui-content [role=status]:not([hidden])")]
      .some((element) => /^Loading/.test(element.textContent ?? ""))
      && !document.getElementById("today-timeline")?.querySelector("[role=status]");
  });
}
