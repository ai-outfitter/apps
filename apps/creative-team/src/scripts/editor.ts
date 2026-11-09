// Every page's writes: a form or button names the document it runs (data-write) and the
// route runs that document, as agents do with graph_mutate. After a save the page reloads
// its records in place, as it does after the member approves an assistant proposal.
import { agentPage } from "@ai-outfitter/app-sdk/agent-context";
import { refreshPage } from "@ai-outfitter/ui/live";
import { onPageLoad } from "@ai-outfitter/ui/page";

const page = agentPage("creative-team");
page.onApplied(() => void refreshPage());

function notice(text: string) {
  const element = document.getElementById("notice");
  if (element) element.textContent = text;
}

onPageLoad((signal) => {
  const root = document.querySelector<HTMLElement>(".creative");
  if (!root) return;
  const base = root.dataset.root ?? "./";
  const content = document.querySelector<HTMLElement>("[data-agent-summary]");
  page.describe({ title: document.title, summary: content?.dataset.agentSummary ?? "" });
  if (import.meta.env.OUTFITTER_APP_MODE === "operational" && root.dataset.demo !== "true") {
    void import("./writes").then(({ bindWrites }) => {
      if (!signal.aborted) bindWrites(signal, base);
    });
    return;
  }
  for (const control of root.querySelectorAll<HTMLElement>("form button, form input, form textarea, form select, button[data-write]"))
    (control as HTMLElement & { disabled: boolean }).disabled = true;
  notice("This demo is read-only: nothing you type is saved.");
});
