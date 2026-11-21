import { storySpecs } from "@ai-outfitter/app-test/stories";
import { test as base, expect, type Page } from "@playwright/test";

export { expect };

/** Story specs run against the app standalone: sign in with the local development form. */
export const { story } = storySpecs(base);

export async function signIn(page: Page, path = "/") {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByRole("button", { name: "Sign in for local development" }).click();
}
