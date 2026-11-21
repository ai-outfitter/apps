import { defineConfig } from "@playwright/test";
import { appPlaywrightConfig } from "@ai-outfitter/app-test/playwright";

const baseURL = "http://127.0.0.1:4518";
export default defineConfig(appPlaywrightConfig(), {
  testMatch: "**/project-releases.browser.spec.ts",
  grep: /read-only Planning demo/,
  use: { baseURL },
  webServer: {
    command: "npm run dev -- --ignore-lock --host 127.0.0.1 --port 4518",
    env: { OUTFITTER_APP_MODE: "demo" },
    url: baseURL + "/projects/00000000-0000-4000-8000-000000000001/releases",
    reuseExistingServer: !process.env.CI,
  },
});
