import { onPageLoad } from "@ai-outfitter/ui/page";
import { roleDetails } from "../fixtures";

onPageLoad(() => {
  const builder = document.getElementById("builder");
  if (!builder) return;
  const form = document.getElementById("role-fields");
  const params = new URLSearchParams(location.search);
  const steps = ["basics", "moc", "description", "level", "interviews", "approval", "publish"];
  let current = Math.max(0, steps.indexOf(params.get("step")));
  const details = roleDetails[builder.dataset.role];

  if (details) {
    for (const [name, value] of Object.entries(details.fields)) {
      const field = form.elements.namedItem(name);
      if (field) field.value = value;
    }
    const log = document.getElementById("messages");
    for (const item of details.conversation) {
      const message = document.createElement("div");
      message.className = `message ${item.role}`;
      const speaker = document.createElement("strong");
      speaker.textContent = item.role === "user" ? "You" : "Kaizen";
      const text = document.createElement("span");
      text.textContent = item.text;
      message.append(speaker, text);
      log.append(message);
    }
  }

  function render() {
    for (const panel of document.querySelectorAll("[data-panel]"))
      panel.hidden = panel.dataset.panel !== steps[current];
    for (const button of document.querySelectorAll("[data-step]")) {
      if (button.dataset.step === steps[current]) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    document.getElementById("step-progress").textContent = `Progress · ${current + 1} of ${steps.length} steps`;
    document.getElementById("previous-step").disabled = current === 0;
    document.getElementById("next-step").hidden = current === steps.length - 1;
  }

  for (const fieldset of form.querySelectorAll("fieldset[data-panel]"))
    fieldset.disabled = true;
  for (const button of document.querySelectorAll("[data-step]"))
    button.addEventListener("click", () => {
      current = steps.indexOf(button.dataset.step);
      render();
    });
  document.getElementById("previous-step").onclick = () => {
    current = Math.max(0, current - 1);
    render();
  };
  document.getElementById("next-step").onclick = () => {
    current = Math.min(steps.length - 1, current + 1);
    render();
  };
  render();
});
