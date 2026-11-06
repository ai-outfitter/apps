interface Option { value: string; label: string }
interface Page { items: Option[]; nextCursor?: string; retryAfterSeconds?: number; error?: string }
interface Config {
  name: string; options: Option[]; selected: string[]; endpoint: string;
  nextCursor?: string; complete: boolean; maxSelections: number; loadDelayMs: number; initialDelayMs: number;
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`${name} is required`);
  return value;
}
function validOptions(value: unknown): value is Option[] {
  return Array.isArray(value) && value.length <= 50_000 && value.every(item =>
    item && typeof item.value === "string" && item.value.length > 0 && item.value.length <= 100 &&
    typeof item.label === "string" && item.label.length > 0 && item.label.length <= 512);
}
function readPage(value: unknown): Page {
  const page = value as Page;
  if (!page || !validOptions(page.items) ||
    (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length > 4000)) ||
    (page.error !== undefined && typeof page.error !== "string") ||
    (page.retryAfterSeconds !== undefined && (typeof page.retryAfterSeconds !== "number" || !Number.isFinite(page.retryAfterSeconds))))
    throw new Error("The option list could not be loaded. Try again.");
  return page;
}
class SearchSelect extends HTMLElement {
  private config!: Config;
  private options = new Map<string, string>();
  private selected = new Set<string>();
  private retryAt = 0;
  private cursor?: string;
  private complete = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private error = "";
  private query!: HTMLInputElement;
  private results!: HTMLElement;
  private chips!: HTMLElement;
  private status!: HTMLElement;
  private errorElement!: HTMLElement;
  private retry!: HTMLButtonElement;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private nextRequestAt = 0;
  connectedCallback() {
    if (this.query) {
      this.controller = new AbortController(); this.busy = false;
      if (!this.complete) this.schedule(this.config.loadDelayMs);
      return;
    }
    this.config = JSON.parse(required(required(this.querySelector("[data-select-config]"), "[data-select-config]").textContent, "select config"));
    this.query = required(this.querySelector("[data-query]"), "[data-query]");
    this.results = required(this.querySelector("[data-options]"), "[data-options]");
    this.chips = required(this.querySelector("[data-selected]"), "[data-selected]");
    this.status = required(this.querySelector("[data-status]"), "[data-status]");
    this.errorElement = required(this.querySelector("[data-error]"), "[data-error]");
    this.retry = required(this.querySelector("[data-retry]"), "[data-retry]");
    this.nextRequestAt = Date.now() + this.config.initialDelayMs;
    this.selected = new Set(this.config.selected);
    this.cursor = this.config.nextCursor;
    this.complete = this.config.complete;
    this.addOptions(this.config.options);
    this.query.disabled = false;
    this.query.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.render();
        if (!this.complete && !this.busy) this.schedule(0);
      }, 250);
    });
    this.query.addEventListener("keydown", event => this.onKey(event));
    this.results.addEventListener("change", event => this.onSelection(event));
    this.chips.addEventListener("click", event => this.onRemove(event));
    this.retry.addEventListener("click", () => this.schedule(0));
    this.render();
    if (!this.complete) this.schedule(this.config.loadDelayMs);
  }
  disconnectedCallback() { this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.searchTimer); }
  private addOptions(options: Option[]) { for (const option of options) this.options.set(option.value, option.label); }
  private items() { return [...this.options].map(([value, label]) => ({ value, label })); }
  private onKey(event: KeyboardEvent) {
    // Apply a pending debounced search first so Enter never focuses a stale result.
    if (event.key === "Enter") { event.preventDefault(); clearTimeout(this.searchTimer); this.render(); this.results.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus(); }
    if (event.key === "Escape") { clearTimeout(this.searchTimer); this.query.value = ""; this.render(); }
  }
  private onSelection(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.type !== "checkbox") return;
    if (input.checked) this.selected.add(input.value); else this.selected.delete(input.value);
    const value = input.value;
    this.render();
    [...this.results.querySelectorAll<HTMLInputElement>("input")].find(item => item.value === value)?.focus();
  }
  private onRemove(event: Event) {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-value]");
    if (!button) return;
    this.selected.delete(required(button.dataset.value, "data-value"));
    this.render();
    this.query.focus();
  }
  private renderChips() {
    this.chips.replaceChildren();
    this.chips.hidden = this.selected.size === 0;
    for (const value of this.selected) {
      const label = this.options.get(value) || value;
      const button = document.createElement("button");
      button.type = "button"; button.dataset.value = value;
      button.setAttribute("aria-label", `Remove ${label}`);
      const text = document.createElement("span"); text.textContent = label;
      const close = document.createElement("span"); close.textContent = "×"; close.setAttribute("aria-hidden", "true");
      button.appendChild(text); button.appendChild(close);
      const input = document.createElement("input"); input.type = "hidden"; input.name = this.config.name; input.value = value;
      this.chips.appendChild(button); this.chips.appendChild(input);
    }
  }
  private renderResults() {
    const query = this.query.value.trim().toLocaleLowerCase();
    const matches = this.items().filter(item => item.label.toLocaleLowerCase().includes(query)).sort((a, b) => a.label.localeCompare(b.label));
    this.results.replaceChildren();
    for (const item of matches.slice(0, 30)) {
      const label = document.createElement("label");
      const input = document.createElement("input"); input.type = "checkbox"; input.value = item.value; input.checked = this.selected.has(item.value);
      input.disabled = !input.checked && this.selected.size >= this.config.maxSelections;
      const text = document.createElement("span"); text.textContent = item.label;
      label.appendChild(input); label.appendChild(text); this.results.appendChild(label);
    }
    if (!matches.length) {
      const empty = document.createElement("p"); empty.textContent = this.complete ? "No matching options." : "Looking for more matches as options load…"; this.results.appendChild(empty);
    }
    const suffix = this.complete ? "All options loaded." : this.error ? "Loading paused." : "Loading more options…";
    const limit = matches.length > 30 ? ` Showing 30 of ${matches.length} matches; type to narrow.` : "";
    this.status.textContent = `${this.selected.size} of ${this.config.maxSelections} selected · ${this.options.size} loaded. ${suffix}${limit}`;
  }
  private render() {
    this.renderChips(); this.renderResults();
    this.errorElement.textContent = this.error; this.errorElement.hidden = !this.error;
    this.retry.hidden = !this.error || this.retryAt > Date.now();
    this.retry.disabled = this.busy;
  }
  private schedule(delay: number) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.loadNext(), Math.max(delay, this.retryAt - Date.now(), this.nextRequestAt - Date.now())); }
  private async fetchPage() {
      const url = new URL(this.config.endpoint, location.href);
      if (url.origin !== location.origin) throw new Error("Option loading must use this site.");
      if (this.cursor) url.searchParams.set("cursor", this.cursor);
      const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal: this.controller.signal });
      if (!response.ok) throw new Error("Could not load more options. Try again or sign in again.");
      return readPage(await response.json());
  }
  private async loadNext() {
    if (!this.isConnected || this.controller.signal.aborted || this.busy) return;
    // A reconnect replaces the controller; an aborted request must not touch the new lifecycle.
    const controller = this.controller;
    clearTimeout(this.timer); this.retryAt = 0; this.busy = true; this.nextRequestAt = Date.now() + this.config.loadDelayMs; this.render();
    try {
      const page = await this.fetchPage();
      if (!controller.signal.aborted) this.applyPage(page);
    } catch (error) {
      if (!controller.signal.aborted) this.error = error instanceof Error ? error.message : "Could not load options.";
    } finally { if (!controller.signal.aborted) { this.busy = false; this.render(); } }
  }
  private applyPage(page: Page) {
      this.addOptions(page.items);
      if (page.error) {
        this.error = page.error;
        this.cursor = page.nextCursor ?? this.cursor;
        if (page.retryAfterSeconds) {
          const delay = Math.max(1, Math.min(3600, page.retryAfterSeconds)) * 1000;
          this.retryAt = Date.now() + delay; this.schedule(delay);
        }
      } else {
        this.error = ""; this.cursor = page.nextCursor; this.complete = !this.cursor;
        if (this.cursor) this.schedule(this.config.loadDelayMs);
      }
  }
}
if (!customElements.get("outfitter-search-select")) customElements.define("outfitter-search-select", SearchSelect);
