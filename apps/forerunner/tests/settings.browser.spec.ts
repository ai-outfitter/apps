import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";
import type { WorkflowHostResult } from "@ai-outfitter/app-sdk/workflow-host";

// A personal installation, as the platform forwards it: the owner is the member.
const member = { userId: "alice", organizationId: "", role: "owner", owner: { kind: "user", id: "alice" } };
const scope = { organizationId: "", installationId: "forerunner", userId: "alice", packageHash: "test", phase: "interactive" as const, expiresAt: Date.now() + 3600000 };
const connection = (id: string, provider: string, operations: string[]) => ({
  id, provider, label: "alice@example.test", revision: "1", owner: "user", operations, repositories: [], resource: "alice@example.test",
});
const gmail = connection("c0000000-0000-4000-8000-000000000001", "gmail", ["messages.list", "messages.get"]);
const calendar = connection("c0000000-0000-4000-8000-000000000002", "google-calendar", ["events.list"]);

test("Settings turns daily discovery on for Gmail, lists sources flat and keeps the member's off", async ({ page }, info) => {
  const schedules: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [];
  const answer = (operation: string, input: Record<string, unknown>): unknown => {
    if (operation === "snapshot")
      return { installation: { id: "forerunner", activeHash: "test", hostname: null, workflows: [] }, bindings: [], subscriptions: [], connections: [gmail, calendar] };
    if (operation === "schedules") return schedules;
    if (operation === "schedule.save") {
      saves.push(input);
      const row = {
        id: "50000000-0000-4000-8000-000000000001", workflowId: input.workflow, cron: "0 7 * * *", timezone: input.timezone, inputs: input.inputs ?? {},
        connectionId: input.connectionId ?? null, resource: input.resource ?? null, createdBy: "alice", enabled: input.enabled ?? true,
        nextRunAt: Date.UTC(2026, 10, 4, 7), lastRunAt: null, lastRunId: null, lastOutcome: null,
      };
      schedules.splice(0, schedules.length, row);
      return row;
    }
    return undefined;
  };
  const app = await appWorker("forerunner", appArtifact(new URL("..", import.meta.url), "operational"), "forerunner", {
    workflowHost: () => ({
      async call(operation, input): Promise<WorkflowHostResult> {
        const value = answer(operation, input as Record<string, unknown>);
        return value === undefined ? { ok: false, status: 400, message: `Unexpected operation ${operation}` } : { ok: true, value: value as never };
      },
    }),
  });
  const origin = "https://forerunner.example";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url());
    await fulfillFrom(route, await app.call(url.pathname + url.search, member, {
      method: request.method(), ...(request.postData() ? { body: request.postDataJSON() } : {}), workflowHost: scope,
    }));
  });
  try {
    await test.step("the first visit turns the daily run on for Gmail", async () => {
      await page.goto(`${origin}/settings`);
      await expect(page.locator("#settings-daily-pill")).toHaveText("On");
      await expect(page.getByRole("switch", { name: "Run daily" })).toBeChecked();
      await expect(page.locator("#settings-daily-status")).toContainText("Reads Gmail · alice@example.test into your knowledge graph.");
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ workflow: "forerunner-discovery", enabled: true, connectionId: gmail.id, inputs: { "analyze.inputs.provider": "gmail" } });
    });
    await test.step("both accounts are listed flat, with a chooser for the daily run and no Google prompt", async () => {
      const sources = page.locator("#settings-sources .source-row[data-source]");
      await expect(sources).toHaveCount(2);
      await expect(sources.first()).toContainText("Not run yet");
      await expect(page.getByRole("link", { name: "Sources", exact: true }).last()).toHaveAttribute("href", "/sources");
      await expect(page.getByRole("combobox", { name: "Account it reads" })).toHaveValue(`connection:${gmail.id}`);
      await expect(page.locator("#settings-google")).toBeHidden();
      await expect(page.locator("#settings-page :is(section, .paper) :is(section, .paper)")).toHaveCount(0);
      await expect(page.getByText("Use data from your agent")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run discovery" })).toHaveCount(0);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await page.screenshot({ path: info.outputPath(`settings-${width}.png`), fullPage: true });
      }
    });
    await test.step("moving the daily run to Calendar saves that account", async () => {
      await page.getByRole("combobox", { name: "Account it reads" }).selectOption(`connection:${calendar.id}`);
      await expect(page.locator("#settings-daily-status")).toContainText("Reads Google Calendar · alice@example.test");
      expect(saves.at(-1)).toMatchObject({ enabled: true, connectionId: calendar.id });
    });
    await test.step("a daily run the member turned off stays off on the next visit", async () => {
      await page.getByRole("switch", { name: "Run daily" }).uncheck();
      await expect(page.locator("#settings-daily-pill")).toHaveText("Off");
      const count = saves.length;
      await page.reload();
      await expect(page.locator("#settings-daily-pill")).toHaveText("Off");
      await page.goto(`${origin}/sources`);
      await expect(page.locator("#sources-connected .source-row")).toHaveCount(2);
      expect(saves).toHaveLength(count);
      expect(schedules[0]).toMatchObject({ enabled: false });
    });
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await app.dispose();
  }
});
