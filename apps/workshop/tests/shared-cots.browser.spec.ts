import { fulfillFrom, fulfillPlatformIdentity } from "@ai-outfitter/app-test/playwright";
import { expect, test } from "@playwright/test";
import { projectPath, projectSlug } from "../src/lib/sections";
import { fixtureMember, probeName, seedSharedCots, sharedCotsWorker, supplierSource } from "./fixtures/shared-cots";

test("a field researcher can inspect one purchased connector and its original photos from either product page", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await sharedCotsWorker();
  const origin = "https://workshop-fixture.example.test";
  try {
    const {
      canonical: ownerItem, ownerRoot, outdoor, bench, absentPart, photos, duplicatePhoto, recordInput, recordEvidence,
    } = await seedSharedCots(fixture);
    const owner = await recordEvidence();
    const [depth, latch] = recordInput.evidence.interfaces;
    await page.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (await fulfillPlatformIdentity(route)) return;
      expect(request.method()).toBe("GET");
      await fulfillFrom(route, await fixture.app.call(url.pathname + url.search, fixtureMember));
    });

    for (const product of [outdoor, bench]) {
      const path = projectPath(projectSlug(product));
      const navigation = await page.goto(origin + path);
      expect(navigation?.status()).toBe(200);
      await expect(page.getByRole("tab", { name: "Purchased parts", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Inspect purchased parts", exact: true }).click();

      const panel = page.getByRole("tabpanel", { name: "Purchased parts" });
      const shared = panel.getByRole("article").filter({
        has: page.getByRole("link", { name: probeName, exact: true }),
      });
      await expect(shared).toHaveCount(1);
      const part = shared.getByRole("link", { name: probeName, exact: true });
      await expect(part).toBeVisible();
      await expect(shared.getByText("Evidence owner", { exact: false })).toBeVisible();
      const canonical = shared.getByRole("link", { name: `${probeName} · project save ${owner.revision}`, exact: true });
      await expect(canonical).toBeVisible();
      await expect(shared.getByText("Part rev A", { exact: false })).toBeVisible();
      expect(new URL((await canonical.getAttribute("href"))!, origin).pathname).toBe(projectPath(owner.id.slice(-12)));
      const attachment = shared.getByRole("link", {
        name: `${ownerRoot.name} (${ownerRoot.number}) · project save ${duplicatePhoto.revision}`,
        exact: true,
      });
      await expect(attachment).toBeVisible();
      const attachmentUrl = new URL((await attachment.getAttribute("href"))!, origin);
      expect(attachmentUrl.searchParams.get("revision")).toBe(String(duplicatePhoto.revision));
      expect(attachmentUrl.searchParams.get("item")).toBe(ownerRoot.id);
      await expect(shared.getByRole("link", { name: "Open supplier reference" })).toHaveAttribute("href", supplierSource);

      await expect(shared.getByRole("heading", { name: depth.feature, exact: true })).toBeVisible();
      await expect(shared.getByText(depth.datum, { exact: true })).toBeVisible();
      await expect(shared.getByText(depth.axis, { exact: true })).toBeVisible();
      await expect(shared.getByText(latch.axis, { exact: true })).toBeVisible();
      await expect(shared.getByText(/18\.2 mm.*owned part/)).toBeVisible();
      const tested = shared.getByRole("link", { name: `Tested project save ${outdoor.revision}` });
      await expect(tested).toBeVisible();
      const testedUrl = new URL((await tested.getAttribute("href"))!, origin);
      expect(testedUrl.pathname).toBe(projectPath(outdoor.id.slice(-12)));
      expect(testedUrl.searchParams.get("revision")).toBe(String(outdoor.revision));
      await expect(shared.getByText("Fit in this assembly selection is unknown.")).toHaveCount(product.id === bench.id ? 1 : 0);
      if (product.id === outdoor.id) {
        const absent = panel.getByRole("article").filter({
          has: page.getByRole("link", { name: absentPart.name, exact: true }),
        });
        await expect(absent.getByText(/no owned-part reference photos or interface dimensions/i)).toBeVisible();
      }

      await expect(shared.getByRole("img")).toHaveCount(photos.length);
      for (const { file, photo } of photos) {
        const link = shared.getByRole("link", { name: `Open reference photo ${file.fileName}`, exact: true });
        const image = link.getByRole("img", { name: file.fileName, exact: true });
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAttribute("href", file.downloadPath);
        await image.scrollIntoViewIfNeeded();
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([photo.width, photo.height]);
      }

      const { file, photo } = photos[0];
      const [openedPhoto] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + file.downloadPath && response.request().isNavigationRequest()),
        shared.getByRole("link", { name: `Open reference photo ${file.fileName}`, exact: true }).click(),
      ]);
      expect(openedPhoto.status()).toBe(200);
      expect(await openedPhoto.body()).toEqual(photo.original);
      await page.goto(origin + path);
      await page.getByRole("tab", { name: "Purchased parts", exact: true }).click();
      const itemHref = await part.getAttribute("href");
      expect(itemHref).toBeTruthy();
      expect(new URL(itemHref!, origin).searchParams.get("item")).toBeTruthy();
      await part.click();
      await expect(page).toHaveURL(new URL(itemHref!, origin).href);
    }

    await page.goto(origin + projectPath(projectSlug(bench)));
    await page.getByRole("button", { name: "Inspect purchased parts", exact: true }).click();
    const trial = page.getByRole("link", { name: `Trial ${depth.verification.trialId}`, exact: true });
    const anchor = `fit-trial-${ownerItem.id}-${depth.id}-${depth.verification.trialId}`;
    await trial.click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#" + anchor);
    const pinnedTrial = page.locator("#" + anchor);
    await expect(pinnedTrial.getByRole("heading", { name: depth.feature, exact: true })).toBeVisible();
    await expect(pinnedTrial.getByText(depth.verification.observation, { exact: true })).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await fixture.app.dispose();
  }
});
