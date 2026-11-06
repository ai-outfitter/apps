import { onPageLoad } from "@ai-outfitter/ui/page";
import { draftPolicyText } from "./draft-policy.js";
import { initProject } from "./project.js";
import { initProjectSettings } from "./project-settings.js";
import { availableRepositories, demoMode, el, loadPage } from "./shared.js";

async function loadSettings(signal) {
  try {
    const page = await loadPage("dashboard");
    if (signal.aborted) return;
    const plugin = page.plugin;
    initProject(page);
    initProjectSettings(page);
    const approved = availableRepositories(plugin);
    const canEdit = Boolean(plugin.canEdit);
    const connected = Boolean(plugin.connected);
    document.querySelector("[data-settings]").textContent = connected
      ? "Manage repositories ↗"
      : "Set up GitHub ↗";
    if (approved.length) el("playground-help").hidden = true;
    if (demoMode) document.querySelectorAll("[data-settings]").forEach((link) => { link.hidden = true; });
    el("repository-summary").textContent = connected
      ? approved.length +
        (approved.length === 1
          ? " available repository. "
          : " available repositories. ") +
        "Your GitHub account is used for interactive actions; workflows use the repository’s GitHub App installation."
      : "Connect your GitHub account once to use repository workflows across Outfitter.";
    const login = plugin.login;
    if (login && canEdit) {
      el("playground").href =
        "https://github.com/new?owner=" +
        encodeURIComponent(login);
      el("playground").hidden = false;
      el("playground-help").textContent =
        "For internal testing, create a private copy of the public outfitter-playground example. Then grant the GitHub App access on GitHub.";
    }
    el("automatic-summary").textContent = "Configure automatic issue workflows in Jobs.";
    el("draft-summary").textContent = draftPolicyText(plugin.connected ? plugin : null);
  } catch (error) {
    if (signal.aborted) return;
    el("notice").textContent =
      `Repository access is unavailable. ${error.message}`;
    el("repository-summary").textContent =
      "Could not check repository access. Review the GitHub connection or reload this page.";
  }
}
onPageLoad((signal) => {
  if (!el("repository-summary")) return;
  void loadSettings(signal);
});
