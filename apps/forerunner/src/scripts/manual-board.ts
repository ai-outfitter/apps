// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: onPageLoad nests the whole page script, which counts every handler as nested.
import { onPageLoad } from "@ai-outfitter/ui/page";
import type { Item } from "../server/schema";
import { boardOrder } from "./board-order";
import { appMount } from "./mount";

function element<T>(selector: string): T {
	const found = document.querySelector(selector) as T | null;
	if (!found) throw new Error(`Missing board element: ${selector}`);
	return found;
}
// Astro hoists component scripts even when the component is not rendered.
// Compile the API adapter out of the read-only demo package entirely.
onPageLoad((signal) => {
	const root =
		import.meta.env.OUTFITTER_APP_MODE === "operational"
			? document.querySelector<HTMLElement>("#manual-board")
			: null;
	if (!root) return;
	const form = element<HTMLFormElement>("#item-form");
	const editor = element<HTMLElement>("#item-editor");
	const showCompleted = element<HTMLInputElement>("#show-completed");
	const error = element<HTMLElement>("#board-error");
	const editorError = element<HTMLElement>("#editor-error");
	const parent = element<HTMLSelectElement>('[name="parentId"]');
	let records: Item[] = [];
	let editing: Item | undefined;
	let category: Item["category"] = "stone";
	let busy = false;
	// The board is one segment below the app root, wherever the app is mounted.
	const endpoint = `${appMount(1)}/api/apps/forerunner/items`;
	async function api(path = "", method = "GET", body?: unknown) {
		const response = await fetch(endpoint + path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: method === "GET" ? signal : undefined,
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}
	function report(target: HTMLElement, message = "") {
		target.textContent = message;
		target.hidden = !message;
	}
	function parents() {
		if (signal.aborted) return;
		const previous = parent.value;
		parent.replaceChildren(
			new Option("No stone", ""),
			...records
				.filter((v) => v.category === "stone")
				.map((v) => new Option(v.title, v.id)),
		);
		parent.value = previous;
		parent.required = category === "pebble";
		element<HTMLElement>("#parent-field").hidden = category === "stone";
	}
	function button(label: string, action: () => void, disabled = false) {
		const el = document.createElement("button");
		el.type = "button";
		el.textContent = label;
		el.className = "button secondary";
		el.disabled = disabled;
		el.addEventListener("click", action);
		return el;
	}
	async function action(work: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		root?.querySelectorAll<HTMLButtonElement>("button").forEach((v) => {
			v.disabled = true;
		});
		report(error);
		try {
			await work();
			if (signal.aborted) return;
			await load();
		} catch (e) {
			report(
				error,
				e instanceof Error ? e.message : "Could not update your board.",
			);
		} finally {
			busy = false;
			if (signal.aborted) return;
			render();
			form.querySelectorAll<HTMLButtonElement>("button").forEach((v) => {
				v.disabled = false;
			});
			element<HTMLButtonElement>("#reload-board").disabled = false;
			root?.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((v) => {
				v.disabled = false;
			});
		}
	}
	function open(value?: Item, kind: Item["category"] = "stone") {
		if (busy) return;
		if (!editor.hidden && !window.confirm("Discard the current item draft?"))
			return;
		editing = value;
		category = value?.category ?? kind;
		form.reset();
		parents();
		for (const key of [
			"title",
			"description",
			"dueDate",
			"status",
			"parentId",
		] as const) {
			(form.elements.namedItem(key) as HTMLInputElement).value =
				value?.[key] ?? (key === "status" ? "todo" : "");
		}
		element<HTMLElement>("#editor-heading").textContent =
			`${value ? "Edit" : "Add"} ${category}`;
		report(editorError);
		editor.hidden = false;
		(form.elements.namedItem("title") as HTMLInputElement).focus();
		editor.scrollIntoView({ block: "nearest" });
	}
	function payload(item: Item) {
		const {
			category,
			title,
			description,
			dueDate,
			status,
			parentId,
			revision,
		} = item;
		return {
			category,
			title,
			description,
			dueDate,
			status,
			parentId,
			revision,
		};
	}
	function metadata(item: Item) {
		const parts = [item.status.replace("-", " ")];
		if (item.dueDate) parts.push(`Due ${item.dueDate}`);
		if (item.parentId)
			parts.push(records.find((v) => v.id === item.parentId)?.title ?? "Stone");
		return parts.join(" · ");
	}
	function render() {
		if (signal.aborted) return;
		for (const kind of ["stone", "pebble", "sand"] as const) {
			const all = records.filter((v) => v.category === kind);
			const visible = all.filter(
				(v) => showCompleted.checked || v.status !== "done",
			);
			const list = element<HTMLOListElement>(`[data-items="${kind}"]`);
			list.replaceChildren();
			element<HTMLElement>(`[data-empty="${kind}"]`).hidden =
				visible.length > 0;
			visible.forEach((item, index) => {
				const li = document.createElement("li");
				const card = document.createElement("article");
				card.className = "forerunner-card board-card";
				card.dataset.item = item.id;
				const title = document.createElement("h3");
				const link = document.createElement("a");
				link.href = `${appMount(1)}/items/${encodeURIComponent(item.id)}`;
				link.textContent = item.title;
                link.className = "board-card-link";
                link.setAttribute("aria-describedby", "board-order-help");
				title.appendChild(link);
				const meta = document.createElement("small");
				meta.textContent = metadata(item);
				card.appendChild(title);
				card.appendChild(meta);
				if (item.description) {
					const p = document.createElement("p");
					p.textContent = item.description;
					card.appendChild(p);
				}
				const controls = document.createElement("div");
				controls.className = "manual-actions";
				const reorder = async (targetId: string) => {
					const items = boardOrder(records, item.id, targetId);
					if (!items) return;
					await action(() => api("/reorder", "POST", { items }));
					root
						?.querySelector<HTMLAnchorElement>(
							`[data-item="${CSS.escape(item.id)}"] .board-card-link`,
						)
						?.focus();
				};
                let pointerId: number | undefined, startX = 0, startY = 0, dragged = false, suppressClick = false;
                let targetId: string | undefined;
                const track = (event: PointerEvent) => {
                  if (pointerId !== event.pointerId) return;
                  if (!dragged && Math.hypot(event.clientX - startX, event.clientY - startY) < 6) return;
                  dragged = true;
                  event.preventDefault();
                  if (!card.hasPointerCapture(event.pointerId)) card.setPointerCapture(event.pointerId);
                  card.dataset.dragging = "true";
                  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-item]");
                  const candidate = records.find(row => row.id === target?.dataset.item);
                  targetId = candidate?.category === item.category && candidate.id !== item.id ? candidate.id : undefined;
                  root?.querySelectorAll<HTMLElement>("[data-drop-target]").forEach(node => { delete node.dataset.dropTarget; });
                  if (targetId && target) target.dataset.dropTarget = "true";
                };
                const finish = (event: PointerEvent) => {
                  if (pointerId !== event.pointerId) return;
                  if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
                  pointerId = undefined;
                  window.removeEventListener("pointermove", track);
                  window.removeEventListener("pointerup", finish);
                  window.removeEventListener("pointercancel", finish);
                  delete card.dataset.dragging;
                  root?.querySelectorAll<HTMLElement>("[data-drop-target]").forEach(node => { delete node.dataset.dropTarget; });
                  if (dragged) {
                    suppressClick = true;
                    window.setTimeout(() => { suppressClick = false; }, 0);
                    if (event.type === "pointerup" && targetId) void reorder(targetId);
                  }
                  targetId = undefined;
                };
                card.addEventListener("pointerdown", event => {
                  if (busy || event.button !== 0 || event.ctrlKey || event.metaKey || pointerId !== undefined || (event.target as Element).closest("button,input,select,textarea")) return;
                  pointerId = event.pointerId; startX = event.clientX; startY = event.clientY; dragged = false;
                  window.addEventListener("pointermove", track, { passive: false, signal });
                  window.addEventListener("pointerup", finish, { signal });
                  window.addEventListener("pointercancel", finish, { signal });
                });
                card.addEventListener("dragstart", event => event.preventDefault());
                card.addEventListener("click", event => {
                  if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
                }, { capture: true });
                card.addEventListener("keydown", event => {
                  if ((event.target as Element).closest("button,input,select,textarea")) return;
                  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
                  if (!direction || busy) return;
                  event.preventDefault();
                  const target = visible[index + direction];
                  if (target) void reorder(target.id);
                });
				const buttons = [
					button(
						item.status === "done" ? "Reopen" : "Complete",
						() =>
							void action(() =>
								api(`/${item.id}`, "PUT", {
									...payload(item),
									status: item.status === "done" ? "todo" : "done",
								}),
							),
						busy,
					),
				];
				for (const control of buttons) controls.appendChild(control);
				card.appendChild(controls);
				li.appendChild(card);
				list.appendChild(li);
			});
		}
	}
	async function load() {
		const result = (await api()) as { items: Item[] };
		if (signal.aborted) return;
		records = result.items;
		render();
		parents();
		element<HTMLElement>("#board-loading").hidden = true;
	}
	root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((el) => {
		el.addEventListener("click", () =>
			open(undefined, el.dataset.add as Item["category"]),
		);
	});
	showCompleted.addEventListener("change", render);
	element<HTMLButtonElement>("#cancel-edit").addEventListener("click", () => {
		editor.hidden = true;
		editing = undefined;
		report(editorError);
	});
	element<HTMLButtonElement>("#reload-board").addEventListener(
		"click",
		() =>
			void action(async () => {
				await load();
				if (editing) {
					const id = editing.id;
					const latest = records.find((v) => v.id === id);
					if (!latest)
						throw new Error(
							"This item was deleted. Your draft is kept; cancel it to add a new item.",
						);
					editing = latest;
				}
				report(editorError);
			}),
	);
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (busy) return;
		busy = true;
		form.querySelectorAll<HTMLButtonElement>("button").forEach((v) => {
			v.disabled = true;
		});
		report(editorError);
		const data = new FormData(form);
		try {
			await api(editing ? `/${editing.id}` : "", editing ? "PUT" : "POST", {
				category,
				title: data.get("title"),
				description: data.get("description"),
				dueDate: data.get("dueDate") || null,
				status: data.get("status"),
				parentId: category === "stone" ? null : data.get("parentId") || null,
				...(editing ? { revision: editing.revision } : {}),
			});
			editor.hidden = true;
			editing = undefined;
			await load();
		} catch (e) {
			report(
				editorError,
				e instanceof Error ? e.message : "Could not save. Your draft is kept.",
			);
		} finally {
			busy = false;
			form.querySelectorAll<HTMLButtonElement>("button").forEach((v) => {
				v.disabled = false;
			});
			render();
		}
	});
	// Home cards link to `?item=<id>`: bring that open item into view once.
	function reveal() {
		const id = new URLSearchParams(location.search).get("item");
		const card = id
			? root?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`)
			: null;
		if (!card) return;
		card.tabIndex = -1;
		card.scrollIntoView({ block: "center" });
		card.focus({ preventScroll: true });
	}
	void load()
		.then(reveal)
		.catch((e) => {
			if (signal.aborted) return;
			report(error, e.message);
			element<HTMLElement>("#board-loading").hidden = true;
		});
});
