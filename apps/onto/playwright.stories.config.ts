import { defineConfig } from "@playwright/test";

// Story specs: this app's value story, walked against the app running
// standalone (`npm run standalone`, docs/standalone-apps.md), capturing
// screenshots as evidence for its alpha product revision (the Evidence bundles
// section of webapp docs/release-artifacts.md). STORY_ORIGIN names the
// running app; the JSON report feeds the evidence bundle.
export default defineConfig({
  testDir: "tests/stories",
  testMatch: "*.story.spec.ts",
  outputDir: "test-results/stories",
  // Each story runs once; a retry would mix two captures into one bundle.
  retries: 0,
  workers: 1,
  timeout: 3 * 60_000,
  use: {
    baseURL: process.env.STORY_ORIGIN ?? "http://127.0.0.1:4321",
    viewport: { width: 1440, height: 1100 },
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM } } : {}),
  },
  reporter: [["list"], ["json", { outputFile: process.env.STORIES_REPORT ?? "test-results/stories/report.json" }]],
});
