import type { Fixtures, Page, TestInfo, TestType } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Story specs: one Playwright test per value story, whose captures become a
 * product revision's evidence bundle (docs/release-artifacts.md, "Evidence
 * bundles from story tests"). The spec declares its story, by slug, with the
 * story's acceptance criteria as its named, ordered steps, and walks the flow
 * calling `evidence.capture(page, { criterion })` at each page a step reaches.
 * `scripts/evidence-bundle.mjs capture` reads the attachments, so what a
 * reviewer sees in Planning is exactly what the test saw, filed by step.
 */
export type StoryDefinition = {
  /** The UserStory's Wiki slug. */
  slug: string;
  title: string;
  actor?: string;
  /** Acceptance criterion slug → title, in step order. */
  criteria: { [slug: string]: string };
};
export type StoryCriterion = { slug: string; title: string };
/** The story as the test annotation and evidence.json carry it. */
export type StoryRecord = { slug: string; title: string; actor?: string; criteria: StoryCriterion[] };

export const viewports = {
  desktop: { width: 1440, height: 1100 },
  mobile: { width: 390, height: 844 },
} as const;
export type Viewport = keyof typeof viewports;

export type CapturedImage = {
  /** Attachment name, also the file name inside the bundle. */
  name: string;
  viewport: Viewport;
  /** What the page showed: `page`, `sidebar-open`, or a state the spec names. */
  state: string;
};
export type CapturedPage = {
  index: number;
  /** The acceptance criterion (story step) this page shows, by slug. */
  criterion: string;
  /** The route the flow intended to reach. */
  route: string;
  /** Where the browser actually was, relative to the origin. */
  finalRoute: string;
  pageTitle: string;
  images: CapturedImage[];
};
/** The JSON attachment `evidence.json` each story test leaves behind. */
export type StoryEvidence = {
  schemaVersion: 2;
  story: StoryRecord;
  pages: CapturedPage[];
  /** What this capture cannot establish; shown with the demonstration. */
  limitations: string[];
};

export type CaptureOptions = { criterion: string; state?: string; route?: string; sidebar?: boolean };
export type Evidence = {
  /** Capture the current page for one of the story's criteria, on desktop and mobile; on mobile also with the navigation drawer open when there is one. */
  capture(page: Page, options: CaptureOptions): Promise<CapturedPage>;
  limitation(text: string): void;
};

export const storyAnnotation = "story";

/** The shared shell closes its mobile drawer again as the page finishes loading; wait for that before driving it. */
export async function shellSettled(page: Page) {
  await expect(page.locator("#sidebar")).toHaveAttribute("data-shell-ready", "");
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0);
}

/**
 * Story declarations over `test`: the result's `story(definition, body)`
 * declares the test for one value story. `ready` waits for the page to settle
 * before the mobile drawer is opened (default `shellSettled`).
 */
export function storySpecs<T extends {}, W extends {}>(base: TestType<T, W>, { ready = shellSettled }: { ready?: (page: Page) => Promise<void> } = {}) {
  const fixtures = {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures destructure their dependencies here
    evidence: async ({}, use: (value: Evidence) => Promise<void>, info: TestInfo) => {
      const annotation = info.annotations.find((item) => item.type === storyAnnotation);
      if (!annotation?.description) throw new Error("Story tests are declared with story(definition, body)");
      const record: StoryEvidence = { schemaVersion: 2, story: JSON.parse(annotation.description), pages: [], limitations: [] };
      const criteria = new Set(record.story.criteria.map((criterion) => criterion.slug));
      let current: Viewport = "desktop";
      const resize = async (page: Page, viewport: Viewport) => {
        if (viewport === current) return;
        current = viewport;
        await page.setViewportSize(viewports[viewport]);
        // Let fonts load and the breakpoint layout paint before the next frame.
        await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
      };
      const shot = async (page: Page, index: number, viewport: Viewport, state: string) => {
        const name = `${String(index).padStart(3, "0")}-${viewport}-${state}.png`;
        await resize(page, viewport);
        // App pages scroll inside .app-shell-content, which fullPage cannot see: grow the viewport by what it hides, up to 4000px.
        const hidden = await page.evaluate(() => {
          const scroller = document.querySelector(".app-shell-content");
          return scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
        });
        const size = viewports[viewport];
        if (hidden > 0) await page.setViewportSize({ width: size.width, height: Math.min(size.height + hidden, 4000) });
        const body = await page.screenshot({ fullPage: true, animations: "disabled" });
        if (hidden > 0) await page.setViewportSize(size);
        await info.attach(name, { body, contentType: "image/png" });
        return { name, viewport, state } satisfies CapturedImage;
      };
      const evidence: Evidence = {
        async capture(page, { criterion, state = "page", route, sidebar = true }) {
          if (!criteria.has(criterion)) throw new Error(`${criterion} is not a criterion of story ${record.story.slug} (${[...criteria].join(", ")})`);
          const index = record.pages.length + 1;
          const url = new URL(page.url());
          const finalRoute = url.pathname + url.search;
          const images: CapturedImage[] = [await shot(page, index, "desktop", state), await shot(page, index, "mobile", state)];
          // The shell's menu button ("Toggle sidebar" on platform pages, "Open navigation" in apps).
          const drawer = page.locator('button[aria-controls="sidebar"]').first();
          if (sidebar && (await drawer.count()) && (await drawer.isVisible())) {
            await ready(page);
            await drawer.click();
            await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
            images.push(await shot(page, index, "mobile", `${state === "page" ? "" : `${state}-`}sidebar-open`));
            await page.keyboard.press("Escape");
          }
          // Back to desktop so the rest of the flow uses the layout it was written against.
          await resize(page, "desktop");
          const captured: CapturedPage = { index, criterion, route: route ?? finalRoute, finalRoute, pageTitle: await page.title(), images };
          record.pages.push(captured);
          return captured;
        },
        limitation(text) {
          record.limitations.push(text);
        },
      };
      await use(evidence);
      await info.attach("evidence.json", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
    },
  };
  // TypeScript cannot resolve Playwright's fixture mapping over a generic base test, so the fixture is typed by hand.
  const test = base.extend<{ evidence: Evidence }>(fixtures as unknown as Fixtures<{ evidence: Evidence }, object, T, W>);
  /** Declares the test for one value story; its criteria are the steps `evidence.capture` files pages under. */
  function story({ slug, title, actor, criteria }: StoryDefinition, body: Parameters<typeof test>[2]) {
    const record: StoryRecord = { slug, title, actor, criteria: Object.entries(criteria).map(([key, value]) => ({ slug: key, title: value })) };
    if (!record.criteria.length) throw new Error(`Story ${slug} declares no criteria`);
    test(title, { annotation: { type: storyAnnotation, description: JSON.stringify(record) } }, body);
  }
  return { story };
}
