/**
 * What the host page has selected for the agent, such as a document, project
 * or task. It is a display hint and a send-time claim from the browser, never
 * authority: the host's server re-reads the item by `kind` and `id`, checks the
 * member may use it, and refuses a stale `revision`.
 */
export interface AgentFocus {
  /** Host-defined type, for example `workshop-project` or `planning-issue`. */
  kind: string;
  /** Stable id the server can look up. */
  id: string;
  /** Human name shown in the panel. */
  label: string;
  /** The version the page shows; sends and approvals carry it so stale ones fail. */
  revision?: string | number;
  project?: { id: string; label: string };
}

/** Whether two focuses name the same item at the same revision. */
export function sameFocus(
  a: AgentFocus | null | undefined,
  b: AgentFocus | null | undefined,
) {
  if (!a || !b) return !a && !b;
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.revision === b.revision &&
    a.project?.id === b.project?.id
  );
}

/** "Bracket (revision 3)"; for notices that compare two focuses. */
export function describeFocus(focus: AgentFocus | null | undefined) {
  if (!focus) return "nothing selected";
  return focus.revision === undefined
    ? focus.label
    : `${focus.label} (revision ${focus.revision})`;
}

export type FieldOptions = Record<
  string,
  { value: string | null; label: string }[]
>;
/** What the page shows, for the agent; `href` ties it to the page that described it. */
export type PageDescription = {
  href: string;
  title?: string;
  summary?: string;
  state?: Record<string, unknown>;
};
export type PageClaim = {
  /** Display choices only; never sent as authority to the agent or app server. */
  fieldOptions?: FieldOptions;
  focus: AgentFocus | null;
  draft?: Record<string, unknown>;
  view?: PageDescription;
};
export function pageContext(id: string) {
  const key = `outfitter:agent-page:${id}`;
  let value: PageClaim = { focus: null };
  const listeners = new Set<() => void>();
  const refresh = new Set<() => void>();
  return {
    get: () => value,
    /** Replaces the claim; the page description stays unless `next` brings one. */
    set(next: PageClaim) {
      value = { view: value.view, ...next };
      for (const notify of listeners) notify();
    },
    /** Tells the agent what this page shows. The sidebar sends it only while the address is unchanged. */
    describe(view: Omit<PageDescription, "href">) {
      // Clamped to what the agent accepts, so one long title never drops the whole view.
      const { title, summary, state } = view;
      value = { ...value, view: { href: location.pathname + location.search,
        ...(title ? { title: title.slice(0, 200) } : {}), ...(summary ? { summary: summary.slice(0, 2000) } : {}),
        ...(state && JSON.stringify(state).length <= 8192 ? { state } : {}) } };
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    onApplied(notify: () => void) {
      refresh.add(notify);
      return () => {
        refresh.delete(notify);
      };
    },
    applied() {
      for (const notify of refresh) notify();
    },
    key,
  };
}
const pages = new Map<string, ReturnType<typeof pageContext>>();
export function agentPage(id: string) {
  if (!pages.has(id)) pages.set(id, pageContext(id));
  return pages.get(id)!;
}
