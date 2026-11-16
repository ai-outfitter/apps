import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { appWorker } from "./fixtures/initialized-worker";
import { expect, type Page, test } from "@playwright/test";
import { core } from "../src/lib/graph";

const origin = "https://wiki.outfitter.example";
const owner = { userId: "owner", organizationId: "org", role: "owner" };
const forerunner = { ...owner, actor: { kind: "app" as const, id: "forerunner" } };
const uuid = (n: number) => `7e0e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (ref: string, n: number, title: string) =>
  ({ operation: "create", type: "graph-node", ref, attributes: { id: uuid(n), typeId: core.person, title } });

test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 900 } });

test("answer an agent's question on the Changes page without approving anything", async ({ page }, info) => {
  const app = await appWorker("onto", appArtifact(new URL("..", import.meta.url), "operational"), "onto-installation", {
    workflowHost: () => ({ call: async () => ({ ok: false, status: 503, message: "No steward in this test" }) }),
  });
  const action = async (name: string, input: object, identity: object = owner) => {
    const response = await app.call("/api/internal/actions/v1/call", identity as typeof owner, { method: "POST", body: { action: name, input } });
    expect(response.status, await response.clone().text()).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: JSON responses under test.
    return response.json() as Promise<Record<string, any>>;
  };
  const shot = async (target: Page, name: string) => {
    await info.attach(name, { body: await target.screenshot({ fullPage: true }), contentType: "image/png" });
    if (process.env.WIKI_SCREENSHOTS) await target.screenshot({ path: `${process.env.WIKI_SCREENSHOTS}/${name}.png`, fullPage: true });
  };
  const staged = async (title: string, base: number) => {
    const { batch } = await action("batch.open", { title, anchors: [] }, forerunner);
    await action("batch.add", { batchId: batch.id, proposals: [
      { operation: node("$shen", base, "Shen Ge"), reason: "Named as the flight hardware lead in the board minutes.", evidence: [{ provider: "gmail", recordId: "minutes-1", quote: "Shen Ge leads flight hardware." }] },
      { operation: node("$lu", base + 1, "Lu Wen"), reason: "Signed the minutes as director." },
    ] }, forerunner);
    return batch.id as string;
  };
  try {
    const plain = await staged("Artera board", 1);
    const asked = await staged("Artera board questions", 10);
    await action("batch.ask", { batchId: asked, questions: [
      { key: "sign-off", ask: "Who signs off flight hardware?", refs: ["$shen"], options: ["Shen Ge alone", "Both directors"] },
      { key: "lu-role", ask: "Is Lu Wen still a director?", refs: ["$lu"] },
    ] }, forerunner);
    for (const id of [plain, asked]) await action("batch.submit", { batchId: id }, forerunner);

    await page.route(`${origin}/**`, async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/platform/threads" && url.searchParams.get("view") === "snapshot") {
        await route.fulfill({ json: { thread: null, entries: [], before: null } });
        return;
      }
      await fulfillFrom(route, await app.call(url.pathname + url.search, owner, {
        method: request.method(), ...(request.postData() ? { body: request.postDataJSON() } : {}),
      }));
    });

    await test.step("a batch without questions looks as before", async () => {
      await page.goto(`${origin}/changes/${plain}`);
      await expect(page.getByRole("heading", { name: "Artera board" })).toBeVisible();
      await expect(page.locator("#questions")).toHaveCount(0);
      await page.getByRole("button", { name: /^Proposals/ }).click();
      await shot(page, "batch-questions-before");
    });

    await test.step("questions show at the top of the batch and on the page of each proposal they name", async () => {
      await page.goto(`${origin}/changes/${asked}`);
      const top = page.locator("#questions");
      await expect(top.getByRole("heading", { name: "Questions" })).toBeVisible();
      await expect(top.locator(".change-question")).toHaveCount(2);
      await expect(top.locator('[data-question="sign-off"]')).toContainText("About Shen Ge");
      await shot(page, "batch-questions-asked");
      await top.getByRole("link", { name: "Shen Ge", exact: true }).click();
      await expect(page.locator(".batch-proposed-line")).toHaveText("Proposed in Artera board questions, not saved");
      await expect(page.locator('.batch-item [data-question="sign-off"]')).toContainText("Who signs off flight hardware?");
      await expect(page.locator(".batch-item [data-question]")).toHaveCount(1);
      await page.getByRole("link", { name: "All proposals", exact: true }).click();
    });

    await test.step("a member picks an option and types an answer; nothing is approved", async () => {
      await page.locator("#questions").getByRole("button", { name: "Both directors" }).click();
      await expect(page.locator('#questions [data-question="sign-off"]')).toContainText("Answer: Both directors");
      const typed = page.locator("#questions").getByRole("textbox", { name: "Answer: Is Lu Wen still a director?" });
      await typed.fill("Yes, until March");
      await typed.press("Enter");
      await expect(page.locator('#questions [data-question="lu-role"]')).toContainText("Answer: Yes, until March");
      await page.locator("#questions").getByRole("link", { name: "Shen Ge", exact: true }).click();
      const shen = page.locator(".batch-item");
      await expect(shen).toContainText("Answer: Both directors");
      await expect(shen.locator(".batch-item-decision")).toContainText("Waiting");
      const detail = await action("batch.get", { batchId: asked });
      expect(detail.counts).toEqual({ awaiting_review: 2 });
      expect(detail.batch.questions.map((item: { answer?: { option?: string; text?: string } }) => item.answer?.option ?? item.answer?.text)).toEqual(["Both directors", "Yes, until March"]);
      await shot(page, "batch-questions-answered");
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
