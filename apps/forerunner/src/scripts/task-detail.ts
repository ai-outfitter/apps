import { onPageLoad } from "@ai-outfitter/ui/page";
import type { Item } from "../server/schema";
import { appMount } from "./mount";

onPageLoad((signal) => {
	const form =
		import.meta.env.OUTFITTER_APP_MODE === "operational"
			? document.querySelector<HTMLFormElement>("#task-form")
			: null;
	if (!form?.dataset.task) return;
	let current = JSON.parse(form.dataset.task) as Item,
		busy = false,
		missing = false;
	const base = appMount(2),
		endpoint = `${base}/api/apps/forerunner/items`;
	const error = document.querySelector<HTMLElement>("#task-error")!,
		message = document.querySelector<HTMLElement>("#task-message")!;
	const refresh = document.querySelector<HTMLButtonElement>("#refresh-task")!,
		remove = document.querySelector<HTMLButtonElement>("#delete-task")!;
	const controls = () => {
		document
			.querySelectorAll<HTMLButtonElement>(
				'[form="task-form"], #delete-task, #refresh-task',
			)
			.forEach((button) => {
				button.disabled = busy || (missing && button !== refresh);
			});
		form
			.querySelectorAll<
				HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
			>("input,select,textarea")
			.forEach((field) => {
				field.disabled = busy || missing;
			});
	};
	const failure = (text = "") => {
		error.textContent = text;
		error.hidden = !text;
	};
	async function api(path = "", method = "GET", body?: unknown) {
		const response = await fetch(endpoint + path, {
			method,
			headers: { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(method === "GET" ? { signal } : {}),
		});
		if (!response.ok) {
			if (response.status === 404) missing = true;
			throw new Error(
				response.status === 404
					? "Task not found. Your draft is kept; return to your board to choose another task."
					: await response.text(),
			);
		}
		return response.json();
	}
	const payload = () => {
		const data = new FormData(form);
		return {
			category: current.category,
			title: data.get("title"),
			description: data.get("description"),
			status: data.get("status"),
			dueDate: data.get("dueDate") || null,
			parentId:
				current.category === "stone" ? null : data.get("parentId") || null,
			revision: current.revision,
		};
	};
	async function action(work: () => Promise<void>) {
		if (busy || signal.aborted) return;
		busy = true;
		failure();
		message.textContent = "";
		try {
			await work();
		} catch (cause) {
			if (!signal.aborted)
				failure(
					cause instanceof Error
						? cause.message
						: "The task could not be updated. Your draft is kept.",
				);
		} finally {
			if (!signal.aborted) {
				busy = false;
				controls();
			}
		}
	}
	form.addEventListener(
		"submit",
		(event) => {
			event.preventDefault();
			const input = payload();
			void action(async () => {
				controls();
				const saved = (await api(
					`/${encodeURIComponent(current.id)}`,
					"PUT",
					input,
				)) as Item;
				if (signal.aborted) return;
				current = saved;
				document.querySelector("#task-revision")!.textContent = String(
					saved.revision,
				);
				document.querySelector(".intro h1")!.textContent = saved.title;
				document.title = `${saved.title} — Forerunner`;
				document.querySelector<HTMLElement>("#latest-task")!.hidden = true;
				message.textContent = "Task saved.";
			});
		},
		{ signal },
	);
	refresh.addEventListener(
		"click",
		() =>
			void action(async () => {
				controls();
				const result = (await api()) as { items: Item[] };
				if (signal.aborted) return;
				const latest = result.items.find((item) => item.id === current.id);
				if (!latest) {
					missing = true;
					throw new Error(
						"Task not found. Your draft is kept; return to your board to choose another task.",
					);
				}
				if (latest.category !== current.category) {
					missing = true;
					throw new Error(
						"This task changed category. Reload this page before editing; your draft is kept.",
					);
				}
				current = latest;
				missing = false;
				document.querySelector("#task-revision")!.textContent = String(
					latest.revision,
				);
				const readback =
					document.querySelector<HTMLDetailsElement>("#latest-task")!;
				readback.hidden = false;
				readback.open = true;
				document.querySelector("#latest-task-value")!.textContent =
					`${latest.title}\n${latest.description}\n${latest.status.replace("-", " ")}${latest.dueDate ? ` · Due ${latest.dueDate}` : ""}${latest.parentId ? ` · Stone: ${result.items.find((item) => item.id === latest.parentId)?.title ?? "Unavailable"}` : ""}`;
				message.textContent =
					"Latest saved version loaded below. Your draft is kept; review it before saving.";
			}),
		{ signal },
	);
	remove.addEventListener(
		"click",
		() => {
			if (
				busy ||
				missing ||
				!window.confirm(
					`Delete “${current.title}”? This cannot be undone. Tasks linked to a stone must be reassigned first.`,
				)
			)
				return;
			void action(async () => {
				controls();
				await api(`/${encodeURIComponent(current.id)}`, "DELETE", {
					revision: current.revision,
				});
				if (!signal.aborted) window.location.assign(`${base}/board`);
			});
		},
		{ signal },
	);
});
