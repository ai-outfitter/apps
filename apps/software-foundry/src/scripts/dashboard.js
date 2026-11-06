import { onPageLoad } from "@ai-outfitter/ui/page";
import { projectMetrics, sparkline } from "./metrics.js";
import { initProject, projectNotice } from "./project.js";
import { renderRanked } from "./ranked-table.js";
import { el, loadPage } from "./shared.js";

const formatter = new Intl.NumberFormat();

function change(metric) {
  if (!metric.previous) return metric.note || "";
  const delta = metric.value - metric.previous;
  const percent = Math.round((Math.abs(delta) / metric.previous) * 100);
  const direction =
    delta === 0 ? "No change" : `${delta > 0 ? "▲" : "▼"} ${percent}%`;
  return [`${direction} vs previous week`, metric.note]
    .filter(Boolean)
    .join(" · ");
}

function renderTiles(project) {
  const metrics = projectMetrics(project);
  for (const tile of document.querySelectorAll("[data-metric]")) {
    const metric = metrics[tile.dataset.metric];
    tile.querySelector(".stat-value").textContent =
      `${formatter.format(metric.value)}${metric.unit || ""}`;
    tile.querySelector(".stat-change").textContent = change(metric);
    tile.querySelector(".stat-spark").textContent = metric.series
      ? sparkline(metric.series)
      : "";
  }
}

function renderMilestones(project) {
  const empty = el("dashboard-milestones-empty");
  el("dashboard-milestones-heading").textContent = `${project.name} milestones`;
  if (project.foundry.error) {
    empty.textContent = `Milestones could not be loaded: ${project.foundry.error}`;
    return;
  }
  renderRanked(el("dashboard-milestones"), project.milestones);
  empty.hidden = project.milestones.length > 0;
  empty.textContent = project.repositories.length
    ? `No open milestones in ${project.name}.`
    : `${project.name} has no repositories. Add some in Settings.`;
}

async function initialize(signal) {
  try {
    // The dashboard opens on the highest priority project unless the URL
    // names one.
    const page = await loadPage("dashboard", {}, { remembered: false });
    if (signal.aborted) return;
    const project = initProject(page);
    if (!project) {
      el("dashboard-milestones-empty").textContent = projectNotice(page);
      return;
    }
    renderTiles(project.name);
    renderMilestones(project);
  } catch (error) {
    el("notice").textContent = `Unable to load the dashboard: ${error.message}`;
  }
}

onPageLoad((signal) => {
  if (!el("dashboard-milestones")) return;
  void initialize(signal);
});
