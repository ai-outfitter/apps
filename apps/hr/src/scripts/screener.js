import { onPageLoad } from "@ai-outfitter/ui/page";
import { screenerCriteria } from "../fixtures";

onPageLoad(() => {
  const root = document.getElementById("screener");
  if (!root) return;
  const criteria = screenerCriteria[root.dataset.role];

  if (criteria) document.getElementById("criteria-summary").textContent = criteria;
  document.getElementById("readiness").textContent = criteria
    ? "Criteria set · review required before screening"
    : "Criteria not set";
  for (const control of root.querySelectorAll("input, textarea, button"))
    control.disabled = true;
});
