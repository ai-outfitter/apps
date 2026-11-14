import cadWorkerURL from "../model/worker.ts?worker&url";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { syncFaces, syncLines } from "replicad-threejs-helper";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type Assembly, assemblyBounds, type Placement, placements } from "../lib/assembly";

export type MeshReply = {
  faces: Parameters<typeof syncFaces>[1];
  edges: Parameters<typeof syncLines>[1];
};

const KIND_COLORS: Record<string, string> = {
  printed: "#d8c3a5",
  cots: "#4a5759",
  pcb: "#2d6a4f",
  assembly: "#bc7c4a",
};

/** A solid with its edges; a see-through solid keeps its opacity in userData. */
export function solidNode(reply: MeshReply, color: string, opacity = 1) {
  const faces = new THREE.BufferGeometry();
  const edges = new THREE.BufferGeometry();
  syncFaces(faces, reply.faces);
  syncLines(edges, reply.edges);
  const solid = new THREE.Mesh(
    faces,
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1 }),
  );
  solid.userData.opacity = opacity;
  const node = new THREE.Group();
  node.add(solid, new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: "#2b2b2b", transparent: true, opacity: 0.3 })));
  return node;
}

/** One placed item: its faces in the item's color (see-through when printed) and its edges. */
export function placedNode(placement: Placement, reply: MeshReply) {
  const { item } = placement;
  const node = solidNode(reply, item.color ?? KIND_COLORS[item.kind] ?? "#888888", item.kind === "printed" ? 0.3 : 1);
  node.userData.itemId = item.id;
  node.position.set(...placement.position);
  node.rotation.z = (placement.rotation * Math.PI) / 180;
  if(placement.matrix){node.matrix.fromArray(placement.matrix);node.matrixAutoUpdate=false;}
  return node;
}

/** The whole assembly in one scene: each item meshed once by the CAD worker,
 * then placed wherever the BOM uses it. Printed parts are see-through so the
 * electronics inside stay visible. */
export function createAssemblyViewer(canvas: HTMLCanvasElement, report: (message: string) => void) {
  const worker = new Worker(import.meta.env.DEV ? cadWorkerURL : new URL(cadWorkerURL.split("/").at(-1)!, import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (reply: MeshReply) => void; reject: (e: Error) => void }>();
  let id = 0;
  let version = 0;
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    data.error ? p?.reject(new Error(data.error)) : p?.resolve(data);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "CAD engine failed"));
    pending.clear();
    report("CAD engine failed. Reload the page to retry.");
  };
  const mesh = (plan: unknown, singlePart?: {params:unknown;plan:unknown}) =>
    new Promise<MeshReply>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      worker.postMessage({ id, plan, ...singlePart });
    });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e8ede5");
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight("#ffffff", 2));
  const light = new THREE.DirectionalLight("#fff8e9", 3);
  light.position.set(80, -120, 240);
  scene.add(light);
  const group = new THREE.Group();
  scene.add(group);
  let frame: { min: number[]; max: number[] } | undefined;
  let selected: string | undefined;

  const resize = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
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

  function reset() {
    if (!frame) return;
    const { min, max } = frame;
    const center = min.map((v, i) => (v + max[i]) / 2);
    const n = Math.max(...max.map((v, i) => v - min[i])) * 1.25;
    camera.near = Math.max(0.01, n / 10000);
    camera.far = Math.max(4000, n * 10);
    camera.updateProjectionMatrix();
    controls.target.set(center[0], center[1], center[2]);
    camera.position.set(center[0] + n, center[1] - n, center[2] + n * 0.8);
    controls.update();
  }

  function clear() {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    group.clear();
  }

  function highlight() {
    for (const node of group.children) {
      const dim = selected !== undefined && node.userData.itemId !== selected;
      node.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const material = child.material as THREE.MeshStandardMaterial;
          material.opacity = dim ? 0.12 : child.userData.opacity;
          material.transparent = material.opacity < 1;
          material.depthWrite = !material.transparent;
          material.needsUpdate = true;
        }
      });
    }
  }

  /** Each distinct item meshed once, however many places use it. */
  async function meshItems(list: Placement[],singlePart?: {params:unknown;plan:unknown}) {
    const items = new Map(list.map(({ item }) => [item.id, item]));
    const replies = await Promise.all([...items.values()].map((item) => mesh(item.geometry,singlePart)));
    return new Map([...items.keys()].map((id, i) => [id, replies[i]]));
  }

  async function render(assembly: Assembly, artifactBase = "", singlePart?: {params:unknown;plan:unknown}) {
    const current = ++version;
    const list = placements(assembly);
    if (!list.length) {
      clear();
      canvas.dataset.ready="false";
      report("This project has no assembly with geometry yet.");
      return;
    }
    report(`Building ${list.length} placed solids…`);
    try {
      const replies = await meshItems(list.filter(p=>!p.item.mesh),singlePart);
      const external=new Map<string,THREE.BufferGeometry>();
      for(const {item} of list)if(item.mesh&&!external.has(item.id)){
        const response=await fetch(artifactBase+item.mesh.path);if(!response.ok)throw new Error(`Cannot load ${item.name}`);
        external.set(item.id,new STLLoader().parse(await response.arrayBuffer()));
      }
      if (current !== version) return;
      clear();
      for (const placement of list) {
        const geometry=external.get(placement.item.id);
        if(!geometry){group.add(placedNode(placement,replies.get(placement.item.id) as MeshReply));continue;}
        const node=new THREE.Group();node.userData.itemId=placement.item.id;
        const solid=new THREE.Mesh(geometry.clone(),new THREE.MeshStandardMaterial({color:placement.item.color??"#8b9f91",roughness:0.65}));solid.userData.opacity=1;node.add(solid);
        if(placement.matrix){node.matrix.fromArray(placement.matrix);node.matrixAutoUpdate=false;}
        group.add(node);
      }
      for(const geometry of external.values())geometry.dispose();
      highlight();
      const firstFrame = !frame;
      frame = assemblyBounds(list);
      if (firstFrame) reset();
      report(`${list.length} solids from ${replies.size + external.size} items · drag to rotate, scroll to zoom`);
      canvas.dataset.ready = "true";
    } catch (e) {
      if (current === version) {
        canvas.dataset.ready = "false";
        report((e as Error).message);
      }
    }
  }

  return {
    render,
    reset,
    /** Show one item at full strength and fade the rest; undefined shows all. */
    isolate(items?: Set<string>) {for(const node of group.children)node.visible=!items||items.has(node.userData.itemId);},
    select(itemId?: string) {
      selected = itemId;
      highlight();
    },
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
  };
}
