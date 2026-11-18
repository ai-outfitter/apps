import { graphBundle } from "../lib/graph-export";
import { call, demoMode, loadGraph, notice } from "./data";
import { typeAdministration } from "./graph";

/** The steward approval choice: saved as soon as an admin picks one. */
async function stewardApproval(form: HTMLFormElement) {
  const inputs = [...form.querySelectorAll<HTMLInputElement>("input[name=stewardApproval]")];
  if (demoMode) { for (const input of inputs) { input.disabled = true; input.checked = input.value === "approve"; } return; }
  const show = (mode: string) => { for (const input of inputs) input.checked = input.value === mode; };
  let saved = "";
  try { saved = (await call<{ stewardApproval: string }>("settings")).stewardApproval; show(saved); }
  catch (error) { notice(String(error)); }
  form.onchange = async () => {
    const mode = inputs.find((input) => input.checked)?.value;
    if (!mode) return;
    for (const input of inputs) input.disabled = true;
    try { saved = (await call<{ stewardApproval: string }>("settings", { stewardApproval: mode })).stewardApproval; notice("Saved."); }
    catch (error) { notice(String(error)); }
    finally { show(saved); for (const input of inputs) input.disabled = false; }
  };
}

function renderSettings() {
  const download = document.getElementById("export-graph") as HTMLButtonElement;
  if (!download || download.dataset.initialized) return;
  download.dataset.initialized = "true";
  download.onclick = async () => {
    try {
      const bundle = graphBundle(await loadGraph());
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "wiki-graph.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notice(String(e));
    }
  };
  const approval = document.getElementById("steward-approval-form") as HTMLFormElement | null;
  if (approval) stewardApproval(approval);
  const administration = document.getElementById("type-administration");
  if (administration)
    loadGraph()
      .then((g) => typeAdministration(administration, g))
      .catch((error) => notice(String(error)));

}
document.addEventListener("astro:page-load", renderSettings);
renderSettings();
