import { onPageLoad } from "@ai-outfitter/ui/page";
import { setOrganizationLink } from "../navigation-link.js";
setOrganizationLink("hr");
onPageLoad(() => {
  // The installed package reads fixtures but never saves or submits changes.
  for (const form of document.querySelectorAll(".local-form, .request-form")) {
    for (const control of form.querySelectorAll("input, select, textarea, button"))
      control.disabled = true;
  }
  if (!document.getElementById("plan-range")) return;
  let monthOffset = 0;
  function timeline() {
    const first = new Date(Date.UTC(2026, 7 + monthOffset, 1));
    const last = new Date(Date.UTC(2026, 13 + monthOffset, 1));
    const months = Array.from(
      { length: 6 },
      (_, i) => new Date(Date.UTC(2026, 7 + monthOffset + i, 1)),
    );
    document.querySelectorAll(".month").forEach((cell, i) => {
      cell.textContent = months[i].toLocaleDateString("en-US", {
        month: "short",
        timeZone: "UTC",
      });
    });
    const range = document.getElementById("plan-range");
    if (range)
      range.textContent = `${months[0].toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} to ${months[5].toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
    for (const cell of document.querySelectorAll("[data-target]")) {
      const target = new Date(`${cell.dataset.target}T00:00:00Z`);
      const end = ((target - first) / (last - first)) * 100;
      const start = Math.max(0, end - 24),
        boundedEnd = Math.min(100, end);
      const bar = cell.querySelector(".timeline-bar");
      bar.hidden = end <= 0 || start >= 100;
      // CSP blocks inline styles; use the Web Animations API for computed geometry.
      bar.getAnimations().forEach((a) => {
        a.cancel();
      });
      bar.animate(
        [
          { left: `${start}%`, width: `${Math.max(0, boundedEnd - start)}%` },
          { left: `${start}%`, width: `${Math.max(0, boundedEnd - start)}%` },
        ],
        { duration: 1, fill: "forwards" },
      );
    }
  }
  for (const button of document.querySelectorAll("[data-plan-month]"))
    button.addEventListener("click", () => {
      const direction = Number(button.dataset.planMonth);
      monthOffset = direction === 0 ? 0 : monthOffset + direction;
      timeline();
    });
  for (const button of document.querySelectorAll("[data-plan-filter]"))
    button.addEventListener("click", () => {
      document
        .querySelectorAll("[data-plan-filter]")
        .forEach((b) => {
          b.setAttribute("aria-pressed", String(b === button));
        });
      document.querySelectorAll("[data-plan-row]").forEach((row) => {
        row.hidden =
          button.dataset.planFilter === "mine" && row.dataset.owner !== "Alex";
      });
    });
  timeline();
});
