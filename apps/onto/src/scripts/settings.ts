import { graphBundle } from "../lib/graph-export";
import { loadGraph, notice } from "./data";
import { typeAdministration } from "./graph";

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
  const administration = document.getElementById("type-administration");
  if (administration)
    loadGraph()
      .then((g) => typeAdministration(administration, g))
      .catch((error) => notice(String(error)));

}
document.addEventListener("astro:page-load", renderSettings);
renderSettings();
