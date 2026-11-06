import { setOC } from "replicad";
import opencascade from "replicad-opencascadejs";
import wasm from "replicad-opencascadejs/wasm?url";
import { buildModel, buildPlannedModel } from "./geometry";

const ready = opencascade({ locateFile: () => wasm }).then(setOC);
self.onmessage = async ({ data }) => {
  try {
    await ready;
    // Assembly items send a plan alone; the single-part editor sends its params too.
    const model = data.params ? buildModel(data.params, data.plan) : buildPlannedModel(data.plan);
    try {
      if (data.format) {
        const blob =
          data.format === "step"
            ? model.solid.blobSTEP()
            : model.solid.blobSTL({ binary: true });
        self.postMessage({ id: data.id, blob });
      } else
        self.postMessage({
          id: data.id,
          faces: model.solid.mesh(),
          edges: model.solid.meshEdges(),
          volume: model.volume,
          checks: model.checks,
        });
    } finally {
      model.solid.delete();
    }
  } catch (e) {
    self.postMessage({
      id: data.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
