import { syncFaces, syncLines } from "replicad-threejs-helper";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type MeshReply = {
  faces: Parameters<typeof syncFaces>[1];
  edges: Parameters<typeof syncLines>[1];
  volume: number;
  checks: string[];
};
type ExportReply = { blob: Blob };

import type { Params } from "../lib/project";
import { type CadPlan, planBounds } from "../model/cad-plan";
export function createViewer(
  canvas: HTMLCanvasElement,
  report: (message: string, checks: string[], valid: boolean) => void,
) {
  const worker = new Worker(new URL("../model/worker.ts", import.meta.url), {
    type: "module",
  });
  const pending = new Map<
    number,
    { resolve: (reply: unknown) => void; reject: (e: Error) => void }
  >();
  let id = 0,
    version = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    data.error ? p?.reject(new Error(data.error)) : p?.resolve(data);
  };
  let failure: Error | undefined;
  worker.onerror = (e) => {
    failure = new Error(e.message || "CAD engine failed. Reload to retry.");
    worker.terminate();
    for (const p of pending.values()) p.reject(new Error(e.message));
    pending.clear();
    report("CAD engine failed. Reload the page to retry.", [], false);
  };
  const request = <T>(payload: object) =>
    new Promise<T>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      pending.set(++id, { resolve: (reply) => resolve(reply as T), reject });
      worker.postMessage({ ...payload, id });
    });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e8ede5");
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight("#ffffff", 2));
  const light = new THREE.DirectionalLight("#fff8e9", 3);
  light.position.set(50, -80, 160);
  scene.add(light);
  const grid = new THREE.GridHelper(260, 26, "#becab5", "#d3ddcb");
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.2;
  scene.add(grid);
  const group = new THREE.Group();
  scene.add(group);
  let params: Params | undefined;
  let plan: CadPlan | undefined;
  let modelKey = "";
  function reset() {
    if (!params) return;
    const n = Math.max(params.width, params.depth, params.height) * 1.9;
    const bounds = plan ? planBounds(plan) : undefined;
    const center = bounds
      ? bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2)
      : [0, 0, params.height / 2];
    controls.target.set(center[0], center[1], center[2]);
    camera.position.set(center[0] + n, center[1] - n, center[2] + n * 0.9);
    controls.update();
  }
  const resize = new ResizeObserver(() => {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (w && h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  });
  resize.observe(canvas);
  renderer.setAnimationLoop(() => {
    if (canvas.offsetParent) {
      controls.update();
      renderer.render(scene, camera);
    }
  });
  function clear() {
    for (const child of [...group.children]) {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((m) => {
          m.dispose();
        });
      }
      group.remove(child);
    }
  }
  async function render(p: Params, nextPlan?: CadPlan) {
    const nextKey = JSON.stringify([p, nextPlan]);
    const changed = nextKey !== modelKey;
    modelKey = nextKey;
    params = { ...p };
    plan = nextPlan;
    grid.position.z = plan ? planBounds(plan).min[2] - 0.2 : -0.2;
    if (changed) reset();
    const current = ++version;
    report("Building geometry…", [], false);
    try {
      const result = await request<MeshReply>({ params, plan });
      if (current !== version) return;
      clear();
      const faces = new THREE.BufferGeometry(),
        edges = new THREE.BufferGeometry();
      syncFaces(faces, result.faces);
      syncLines(edges, result.edges);
      group.add(
        new THREE.Mesh(
          faces,
          new THREE.MeshStandardMaterial({
            color: "#bc7c4a",
            roughness: 0.62,
            metalness: 0.05,
            polygonOffset: true,
            polygonOffsetFactor: 1,
          }),
        ),
      );
      group.add(
        new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: "#744e35",
            transparent: true,
            opacity: 0.4,
          }),
        ),
      );
      report(
        `${(result.volume / 1000).toFixed(1)} cm³ · geometry ready`,
        result.checks,
        true,
      );
      canvas.dataset.ready = "true";
    } catch (e) {
      if (current === version) {
        clear();
        canvas.dataset.ready = "false";
        report((e as Error).message, [], false);
      }
    }
  }
  return {
    render,
    reset,
    /** Stops the engine and frees the canvas's GL context once the page leaves. */
    dispose() {
      version++;
      resize.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      clear();
      renderer.dispose();
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("The 3D preview closed."));
      pending.clear();
    },
    export: async (format: "step" | "stl", p: Params, cadPlan?: CadPlan) => {
      const result = await request<ExportReply>({
        params: p,
        plan: cadPlan,
        format,
      });
      return result.blob;
    },
  };
}
