import { onPageLoad } from "@ai-outfitter/ui/page";

// A project's "Link merged PRs in the Wiki": runs the LinkProjectChanges document
// through /api/apps/planning/code-changes and says what was staged. The Wiki's
// Changes page is where a member reviews what did not commit by policy.
type Linked = { pullRequests: number; proposals: number; skipped: number; state: string | null; unread: string[] };

export function linkSummary(value: Linked) {
  const unread = value.unread.length ? ` Not read: ${value.unread.join("; ")}.` : "";
  if (!value.pullRequests) return `No new merged pull requests to link.${unread}`;
  const skipped = value.skipped ? ` ${value.skipped} could not be attributed to a project.` : "";
  return `${value.pullRequests} merged pull requests staged in the Wiki (${value.state ?? "not submitted"}). Confident links commit; the rest wait on the Wiki's Changes page.${skipped}${unread}`;
}

// The read-only demo makes no operational calls: the build drops this whole branch.
if (import.meta.env.OUTFITTER_APP_MODE !== "demo") {
/** POST the link request; answers the status line to show. */
async function link(projectId: string, signal: AbortSignal) {
  const response = await fetch("/api/apps/planning/code-changes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }), signal,
  });
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return linkSummary((await response.json()) as Linked);
}

onPageLoad((signal) => {
  const button = document.querySelector<HTMLButtonElement>("#link-changes");
  const status = document.querySelector<HTMLElement>("#link-changes-status");
  if (!button || !status) return;
  const show = (text: string) => { status.textContent = text; status.hidden = !text; };
  button.addEventListener("click", async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Linking…";
    show("");
    const text = await link(button.dataset.projectId ?? "", signal).catch((error: unknown) => (error instanceof Error ? error.message : "Request failed"));
    if (signal.aborted) return;
    show(text);
    button.disabled = false;
    button.textContent = label;
  }, { signal });
});
}
