import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import { fulfillFrom } from "@ai-outfitter/app-test/playwright";

const origin = "https://forerunner.unsupervised.example";

for (const width of [1440, 390]) {
	test(`member manages a persistent private board at ${width}px`, async ({
		page,
	}, info) => {
		const worker = await appWorker(
			"forerunner",
			appArtifact(new URL("..", import.meta.url), "operational"),
			"install",
		);
		const failures: string[] = [];
		page.on("pageerror", (e) => failures.push(e.message));
		page.on("console", (e) => {
			if (e.type() === "error") failures.push(e.text());
		});
		// The platform authenticates before dispatch and replaces identity headers.
		let member = "alice";
		const headers = () => ({
			"x-outfitter-user": member,
			"x-outfitter-organization": "org",
			"x-outfitter-installation": "install",
			"x-outfitter-role": "member",
		});
		await page.route(`${origin}/**`, async (route) => {
			const req = route.request();
			const response = await worker.fetch(req.url(), {
				method: req.method(),
				headers: { ...req.headers(), ...headers() },
				body: req.postData() ?? undefined,
			});
			await fulfillFrom(route, response);
		});
		try {
			await page.setViewportSize({ width, height: 900 });
			await test.step("new installation is empty; create a stone and linked pebble", async () => {
				await page.goto(`${origin}/board`);
				await expect(page.getByText("No stones yet.")).toBeVisible();
				// Operational Forerunner offers its private agent sidebar (#791).
				await expect(
					page.getByRole("button", { name: "Ask Forerunner" }),
				).toBeVisible();
				await page
					.getByRole("button", { name: "Add stone", exact: true })
					.click();
				await page
					.getByLabel("Title", { exact: true })
					.fill("Ship the manual board");
				await page
					.getByLabel("Description", { exact: true })
					.fill("Keep this private");
				await page.getByRole("button", { name: "Save item" }).click();
				await expect(
					page.getByRole("heading", { name: "Ship the manual board" }),
				).toBeVisible();
				await page
					.getByRole("button", { name: "Add pebble", exact: true })
					.click();
				await page
					.getByLabel("Title", { exact: true })
					.fill("Check persistence");
				await page
					.getByLabel("Stone", { exact: true })
					.selectOption({ label: "Ship the manual board" });
				await page.getByRole("button", { name: "Save item" }).click();
				await expect(
					page.getByRole("heading", { name: "Check persistence" }),
				).toBeVisible();
			});
			await test.step("edit, reload, complete and reopen a standalone sand item", async () => {
				await page
					.getByRole("button", { name: "Add sand", exact: true })
					.click();
				await page.getByLabel("Title", { exact: true }).fill("Small task");
				await page.getByRole("button", { name: "Save item" }).click();
				const card = page.locator("article").filter({
					has: page.getByRole("heading", { name: "Small task", exact: true }),
				});
				await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
                await card.click({ position: { x: 8, y: 8 } });
				await page
					.getByLabel("Title", { exact: true })
					.fill("Small task edited");
				await page.getByRole("button", { name: "Save changes" }).click();
                await page.locator(".intro").getByRole("link", { name: "Your board", exact: true }).click();
                await expect(page).toHaveURL(/\/board$/);
				await page.reload();
				const edited = page.locator("article").filter({
					has: page.getByRole("heading", {
						name: "Small task edited",
						exact: true,
					}),
				});
				await expect(edited).toBeVisible();
				await edited
					.getByRole("button", { name: "Complete", exact: true })
					.click();
				await expect(edited).toHaveCount(0);
				await page.getByLabel("Show completed items").check();
				await edited
					.getByRole("button", { name: "Reopen", exact: true })
					.click();
				await page.getByLabel("Show completed items").uncheck();
				await expect(edited).toBeVisible();
				await page.locator(".ui-content").evaluate((el) => {
					el.scrollTop = 0;
				});
				await page.screenshot({
					path: info.outputPath(`forerunner-manual-${width}.png`),
					fullPage: true,
				});
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					),
				).toBe(false);
			});
			await test.step("ordering persists and a stone with children cannot be deleted", async () => {
				await page
					.getByRole("button", { name: "Add sand", exact: true })
					.click();
				await page
					.getByLabel("Title", { exact: true })
					.fill("Another small task");
				await page.getByRole("button", { name: "Save item" }).click();
				const another = page.locator("article").filter({
					has: page.getByRole("heading", {
						name: "Another small task",
						exact: true,
					}),
				});
				await expect(
					page.getByRole("button", { name: /Move up|Move down|^Delete$/ }),
				).toHaveCount(0);
				const handle = another.getByRole("link", {
					name: "Another small task",
					exact: true,
				});
				if (width < 760) {
					await handle.focus();
					await page.keyboard.press("ArrowLeft");
				} else {
					const from = (await another.boundingBox())!,
						to = (await page
							.locator('[data-items="sand"] article')
							.first()
							.boundingBox())!;
					await page.mouse.move(
						from.x + from.width - 20,
						from.y + 20,
					);
					await page.mouse.down();
					await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
						steps: 8,
					});
					await page.mouse.up();
				}
				const sandTitles = page.locator('[data-items="sand"] h3');
				await expect(sandTitles).toHaveText([
					"Another small task",
					"Small task edited",
				]);
				await page.reload();
				await expect(sandTitles).toHaveText([
					"Another small task",
					"Small task edited",
				]);
				await another
					.getByRole("link", { name: "Another small task", exact: true })
					.click();
				page.once("dialog", (dialog) => dialog.accept());
				await page
					.getByRole("button", { name: "Delete task", exact: true })
					.click();
				await expect(page).toHaveURL(/\/board$/);
				await expect(another).toHaveCount(0);
				const stone = page.locator("article").filter({
					has: page.getByRole("heading", {
						name: "Ship the manual board",
						exact: true,
					}),
				});
				await stone
					.getByRole("link", { name: "Ship the manual board", exact: true })
					.click();
				await expect(
					page.getByRole("region", { name: "Tasks in this stone" }),
				).toContainText("Check persistence");
				page.once("dialog", (dialog) => dialog.accept());
				await page
					.getByRole("button", { name: "Delete task", exact: true })
					.click();
				await expect(page.locator("#task-error")).toContainText(
					"Reassign or detach children",
				);
				await page
					.locator(".intro")
					.getByRole("link", { name: "Your board", exact: true })
					.click();
				await expect(stone).toBeVisible();
			});
			await test.step("a stale edit preserves the draft and allows explicit refresh and retry", async () => {
				const card = page.locator("article").filter({
					has: page.getByRole("heading", {
						name: "Small task edited",
						exact: true,
					}),
				});
				await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
                await card.click({ position: { x: 8, y: 8 } });
				await page.getByLabel("Title", { exact: true }).fill("Kept draft");
				const response = await worker.fetch(
					`${origin}/api/apps/forerunner/items`,
					{ headers: headers() },
				);
				const { items } = (await response.json()) as {
					items: { id: string; title: string; revision: number }[];
				};
				const item = items.find((v) => v.title === "Small task edited");
				if (!item) throw new Error("Expected persisted sand item");
				await worker.fetch(`${origin}/api/apps/forerunner/items/${item.id}`, {
					method: "PUT",
					headers: { ...headers(), "Content-Type": "application/json" },
					body: JSON.stringify({
						category: "sand",
						title: "Changed elsewhere",
						revision: item.revision,
					}),
				});
				await page.getByRole("button", { name: "Save changes" }).click();
				await expect(page.locator("#task-error")).toContainText(
					"draft is kept",
				);
				await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
					"Kept draft",
				);
				await page.getByRole("button", { name: "Load latest revision" }).click();
				await expect(
					page.locator("#latest-task-value"),
				).toContainText("Changed elsewhere");
				await page.getByRole("button", { name: "Save changes" }).click();
				await expect(
					page.getByRole("heading", { name: "Kept draft" }),
				).toBeVisible();
			});
			await test.step("a home card item link opens its canonical task page", async () => {
				const response = await worker.fetch(
					`${origin}/api/internal/home-cards/v1/read`,
					{
						method: "POST",
						headers: {
							...headers(),
							"x-outfitter-owner": "organization:org",
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ cardId: "my-priorities", size: "large" }),
					},
				);
				const card = (await response.json()) as {
					body: {
						kind: string;
						items?: { title: string; link: { path: string } }[];
					}[];
				};
				const link = card.body
					.find((node) => node.kind === "list")
					?.items?.find((item) => item.title === "Kept draft")?.link;
				if (!link) throw new Error("Expected the item on the home card");
				await page.goto(origin + link.path);
				await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
					"Kept draft",
				);
				await expect(page).toHaveURL(/\/items\/[a-f0-9-]+$/);
			});
			await test.step("another member sees an empty board", async () => {
				member = "bob";
				await page.goto(`${origin}/board`);
				await expect(page.getByText("No stones yet.")).toBeVisible();
				await expect(page.getByText("No pebbles yet.")).toBeVisible();
				await expect(page.getByText("No sand yet.")).toBeVisible();
			});
			expect(failures.filter((v) => !v.includes("409"))).toEqual([]);
		} finally {
			try {
				await page.unrouteAll({ behavior: "wait" });
			} finally {
				await worker.dispose();
			}
		}
	});
}
