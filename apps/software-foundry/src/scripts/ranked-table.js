import { milestoneHref } from "./project.js";

function text(tag, value = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function progressBar(milestone) {
  const total = milestone.openItems + milestone.closedItems;
  if (!total) return "No issues yet";
  const filled = Math.round((milestone.closedItems / total) * 10);
  return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${milestone.closedItems}/${total}`;
}

function moveButton(label, name, onClick) {
  const button = text("button", label, "secondary rank-move");
  button.type = "button";
  button.setAttribute("aria-label", name);
  button.onclick = onClick;
  return button;
}

function milestoneCopy(milestone) {
  const copy = text("div", "", "milestone-copy-text");
  const title = text("a", milestone.title, "milestone-title");
  title.href = milestoneHref(milestone);
  copy.append(
    title,
    text(
      "span",
      milestone.description || "No press release yet.",
      milestone.description ? "press-release" : "press-release missing",
    ),
  );
  return copy;
}

/**
 * A project's milestones, most important first. Order is the rank. With
 * `move`, each milestone gets up and down controls that call
 * `move(index, offset)`.
 */
export function renderRanked(body, milestones, move) {
  body.replaceChildren(
    ...milestones.map((milestone, index) => {
      const row = text("tr");
      const cell = text("td", "", "milestone-copy");
      cell.append(milestoneCopy(milestone));
      if (move) {
        const controls = text("div", "", "rank-controls");
        controls.append(
          moveButton("↑", `Move ${milestone.title} up`, () => move(index, -1)),
          moveButton("↓", `Move ${milestone.title} down`, () =>
            move(index, 1),
          ),
        );
        cell.append(controls);
      }
      row.append(cell, text("td", progressBar(milestone), "progress-text"));
      return row;
    }),
  );
}
