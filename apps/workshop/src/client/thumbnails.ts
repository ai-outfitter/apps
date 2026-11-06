import * as THREE from "three";
import { placements } from "../lib/assembly";
import type { Project } from "../lib/project";
import { type MeshReply, placedNode, solidNode } from "./assembly-viewer";

/** Renders small still pictures of project models, one at a time, with one
 * CAD worker and one WebGL context however many projects the page lists. */
export function createThumbnailer(width = 480, height = 300) {
  const worker = new Worker(new URL("../model/worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (reply: MeshReply) => void; reject: (e: Error) => void }>();
  let id = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    data.error ? p?.reject(new Error(data.error)) : p?.resolve(data);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "CAD engine failed"));
    pending.clear();
  };
  const mesh = (payload: object) =>
    new Promise<MeshReply>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      worker.postMessage({ ...payload, id });
    });

  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e8ede5");
  scene.add(new THREE.AmbientLight("#ffffff", 2));
  const light = new THREE.DirectionalLight("#fff8e9", 3);
  light.position.set(80, -120, 240);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 4000);
  camera.up.set(0, 0, 1);
  const group = new THREE.Group();
  scene.add(group);
  let queue: Promise<unknown> = Promise.resolve();

  function clear() {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    group.clear();
  }

  async function build(p: Project) {
    const list = placements(p.assembly);
    if (list.length) {
      const items = [...new Map(list.map(({ item }) => [item.id, item])).values()];
      const replies = new Map(await Promise.all(items.map(async (item) => [item.id, await mesh({ plan: item.geometry })] as const)));
      for (const placement of list) group.add(placedNode(placement, replies.get(placement.item.id) as MeshReply));
      // Printed parts stay see-through, as in the assembly view.
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.opacity < 1) {
          const material = child.material as THREE.MeshStandardMaterial;
          material.transparent = true;
          material.opacity = child.userData.opacity;
          material.depthWrite = false;
        }
      });
      return;
    }
    const reply = await mesh({ params: { ...p.params }, plan: p.cadPlan });
    group.add(solidNode(reply, "#bc7c4a"));
  }

  async function draw(p: Project, target: HTMLCanvasElement) {
    clear();
    await build(p);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const n = Math.max(size.x, size.y, size.z) * 1.35;
    camera.position.set(center.x + n, center.y - n, center.z + n * 0.8);
    camera.lookAt(center);
    renderer.render(scene, camera);
    // Copied into the page's own canvas: the app's CSP admits no data: images.
    target.width = width;
    target.height = height;
    target.getContext("2d")?.drawImage(canvas, 0, 0);
    clear();
  }

  return {
    /** Draws the project's model, or its whole assembly, into a canvas on the page. */
    render(p: Project, target: HTMLCanvasElement): Promise<void> {
      const next = queue.then(() => draw(p, target));
      queue = next.catch(() => {});
      return next;
    },
    dispose() {
      clear();
      renderer.dispose();
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("Closed"));
      pending.clear();
    },
  };
}
