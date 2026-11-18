import { expect, test } from "@playwright/test";
import { appWorker } from "@ai-outfitter/app-test/worker";
import { appArtifact } from "@ai-outfitter/app-test/prepare";
import {
	fulfillFrom,
	fulfillPlatformIdentity,
	isPlatformIdentityRequest,
} from "@ai-outfitter/app-test/playwright";
import {
	identityHeaderValues,
	pageURLHeader,
} from "@ai-outfitter/app-sdk/server";

const origin = "https://forerunner.example";
for (const mount of ["/apps/forerunner/", "/o/example/forerunner/"])
	test(`task pages preserve drafts, completion and private authority at ${mount}`, async ({
		page,
	}, info) => {
		const worker = await appWorker(
			"forerunner",
			appArtifact(new URL("..", import.meta.url), "operational"),
			"detail-install",
		);
		let userId = "alice";
		const who = () => ({
			userId,
			organizationId: mount.startsWith("/o/") ? "org" : "",
			role: "member",
			...(mount.startsWith("/apps/")
				? { owner: { kind: "user" as const, id: userId } }
				: {}),
		});
		const api = (path: string, method = "GET", body?: unknown) =>
			worker.call(`/api/apps/forerunner/items${path}`, who(), {
				method,
				...(body ? { body } : {}),
			});
		try {
			const created = await api("", "POST", {
				category: "stone",
				title: "Deliver the customer outcome",
			});
			expect(created.status).toBe(200);
			const stone = (await created.json()) as { id: string };
			const result = await api("", "POST", {
				category: "sand",
				title: "Review the customer evidence",
				parentId: stone.id,
			});
			const task = (await result.json()) as { id: string; revision: number };
			let deleteRequests = 0;
			await page.route(`${origin}/**`, async (route) => {
				const request = route.request(),
					url = new URL(request.url());
				if (isPlatformIdentityRequest(url)) {
					await fulfillPlatformIdentity(route);
					return;
				}
				const path = url.pathname.startsWith(mount)
					? url.pathname.slice(mount.length)
					: url.pathname.slice(1);
				if (request.method() === "DELETE") deleteRequests++;
				const headers = new Headers(request.headers());
				for (const [key, value] of Object.entries(
					identityHeaderValues({
						...who(),
						installationId: worker.installationId,
					}),
				))
					headers.set(key, value);
				headers.set(pageURLHeader, request.url());
				await fulfillFrom(
					route,
					await worker.dispatch(
						"",
						new Request(`${origin}/${path}${url.search}`, {
							method: request.method(),
							headers,
							body: request.postData(),
						}),
					),
				);
			});
			await page.goto(`${origin}${mount}board`);
			await page
				.getByRole("link", {
					name: "Review the customer evidence",
					exact: true,
				})
				.click();
			await expect(page).toHaveURL(new RegExp(`/items/${task.id}$`));
			await expect(page.locator("#task-form")).toHaveAttribute("method", "post");
			await expect(page.getByLabel("Stone", { exact: true })).toHaveValue(
				stone.id,
			);
			await page
				.getByLabel("Description", { exact: true })
				.fill("Review with the customer before delivery.");
			await page
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(page.locator("#task-message")).toHaveText("Task saved.");
			await page.reload();
			await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
				"Review with the customer before delivery.",
			);
			const all = (await (await api("")).json()) as {
				items: { id: string; revision: number }[];
			};
			const latest = all.items.find((item) => item.id === task.id)!;
			await api(`/${task.id}`, "PUT", {
				category: "sand",
				title: "Changed on another device",
				description: "Review this saved version",
				parentId: stone.id,
				revision: latest.revision,
			});
			await page.getByLabel("Title", { exact: true }).fill("My kept draft");
			await page
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(page.locator("#task-error")).toContainText("draft is kept");
			await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
				"My kept draft",
			);
			await page
				.getByRole("button", { name: "Load latest revision", exact: true })
				.click();
			await expect(page.locator("#latest-task-value")).toContainText(
				"Changed on another device",
			);
			await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
				"My kept draft",
			);
			await page
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(page.locator("#task-message")).toHaveText("Task saved.");
			await page.getByLabel("Status", { exact: true }).selectOption("done");
			await page
				.getByRole("button", { name: "Save changes", exact: true })
				.click();
			await expect(page.locator("#task-message")).toHaveText("Task saved.");
			await page
				.locator(".intro")
				.getByRole("link", { name: "Your board", exact: true })
				.click();
			await expect(
				page.getByRole("link", { name: "My kept draft", exact: true }),
			).toHaveCount(0);
			await page.getByLabel("Show completed items").check();
			await page
				.getByRole("link", { name: "My kept draft", exact: true })
				.click();
			page.once("dialog", (dialog) => dialog.dismiss());
			await page
				.getByRole("button", { name: "Delete task", exact: true })
				.click();
			expect(deleteRequests).toBe(0);
			await page.setViewportSize({ width: 390, height: 844 });
			await page.screenshot({
				path: info.outputPath("task-detail-mobile.png"),
				fullPage: true,
			});
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
			page.once("dialog", (dialog) => dialog.accept());
			await page
				.getByRole("button", { name: "Delete task", exact: true })
				.click();
			await expect(page).toHaveURL(new RegExp(`${mount}board$`));
			expect(deleteRequests).toBe(1);
			const missing = await page.goto(`${origin}${mount}items/${task.id}`);
			expect(missing?.status()).toBe(404);
			await expect(page.getByRole("alert")).toHaveText(
				"Task not found. It may have been deleted or belong to another board.",
			);
			userId = "bob";
			const foreign = await page.goto(`${origin}${mount}items/${stone.id}`);
			expect(foreign?.status()).toBe(404);
			await expect(
				page.getByRole("button", { name: "Delete task", exact: true }),
			).toHaveCount(0);
			await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
		} finally {
			try {
				await page.unrouteAll({ behavior: "wait" });
			} finally {
				await worker.dispose();
			}
		}
	});
