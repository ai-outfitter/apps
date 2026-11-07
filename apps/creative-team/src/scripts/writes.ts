// Loaded only in operational builds, so the demo bundle carries no API calls.

import { navigate } from "astro:transitions/client";
import { onRefresh, refreshPage } from "@ai-outfitter/ui/live";

function notice(text: string) {
  const element = document.getElementById("notice");
  if (element) element.textContent = text;
}

/** Sets `input[a][0][b]` from a field named `a.0.b`. */
function assign(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let at: Record<string, unknown> | unknown[] = target;
  keys.forEach((key, index) => {
    const last = index === keys.length - 1;
    const slot = /^\d+$/.test(key) ? Number(key) : key;
    const container = at as Record<string | number, unknown>;
    if (last) container[slot] = value;
    else {
      container[slot] ??= /^\d+$/.test(keys[index + 1]) ? [] : {};
      at = container[slot] as Record<string, unknown>;
    }
  });
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const skip = Symbol("skip");

/** A field's value: numbers are numbers, nullable choices may be null, empty hidden or optional fields are left out. */
function fieldValue(field: Field): unknown {
  const { value } = field;
  if (field.dataset.kind === "number") return value === "" ? skip : Number(value);
  if (field.dataset.kind === "nullable") return value || null;
  if (field.type === "hidden" && value === "") return skip;
  if (field.dataset.optional === "true" && value.trim() === "") return skip;
  return value;
}

/** The form's input, with text kept as typed. */
export function formInput(form: HTMLFormElement) {
  const input: Record<string, unknown> = {};
  for (const field of Array.from(form.elements) as Field[]) {
    if (!field.name || field.disabled) continue;
    const value = fieldValue(field);
    if (value !== skip) assign(input, field.name, value);
  }
  return input;
}

async function write(root: string, document: string, input: unknown) {
  const response = await fetch(`${root}api/apps/creative-team/${document}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!response.ok) throw new Error((await response.text()) || `Save failed (${response.status})`);
  return response.json();
}

export function bindWrites(signal: AbortSignal, base: string) {
  onRefresh(signal, () => navigate(location.href, { history: "replace" }));
  const busy = async (control: HTMLElement, run: () => Promise<void>) => {
    if (control.getAttribute("aria-busy") === "true") return;
    control.setAttribute("aria-busy", "true");
    try {
      await run();
    } catch (error) {
      if (!signal.aborted) notice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      control.removeAttribute("aria-busy");
    }
  };
  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.dataset.write) return;
    event.preventDefault();
    void busy(form, async () => {
      await write(base, form.dataset.write ?? "", formInput(form));
      if (signal.aborted) return;
      await refreshPage();
      // The refreshed page has its own status line.
      notice(form.dataset.saved ?? "Saved.");
    });
  }, { signal });
  document.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-write]");
    if (!button || button.form) return;
    if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
    void busy(button, async () => {
      await write(base, button.dataset.write ?? "", JSON.parse(button.dataset.input ?? "{}"));
      if (signal.aborted) return;
      await refreshPage();
      // The refreshed page has its own status line.
      notice(button.dataset.saved ?? "Saved.");
    });
  }, { signal });
}
