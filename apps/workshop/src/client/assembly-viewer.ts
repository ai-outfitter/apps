import type { MeshSource } from "../lib/assembly-resolution";
import { attachedMesh } from "../lib/assembly-file";
import { appBase } from "../lib/sections";
import { verifiedArtifact, type ArtifactRecord } from "../lib/artifact";
import { savedMotionMatrix, type PlacedRotation } from "../lib/saved-drive-motion";
import { createZDriveInspection } from "./z-drive-inspection";
import { zDriveTurns, type ZDriveInspection } from "../lib/artera-drive-review";
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
  node.add(solid, new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: "#2b2b2b", transparent: true, opacity: Math.min(0.3, opacity), depthWrite: false })));
  return node;
}

/** One placed item: its faces in the item's color (see-through when printed) and its edges. */
export function placedNode(placement: Placement, reply: MeshReply) {
  const { item } = placement;
  const node = solidNode(reply, item.color ?? KIND_COLORS[item.kind] ?? "#888888", item.opacity ?? (item.kind === "printed" ? 0.3 : 1));
  node.userData.itemId = item.id;
  node.userData.pickGroup = placement.pickGroup;
  node.userData.path = placement.path;
  node.position.set(...placement.position);
  node.rotation.z = (placement.rotation * Math.PI) / 180;
  if(placement.matrix){node.matrix.fromArray(placement.matrix);node.matrixAutoUpdate=false;}
  return node;
}

/** The whole assembly in one scene: each item meshed once by the CAD worker,
 * then placed wherever the BOM uses it. Printed parts are see-through so the
 * electronics inside stay visible. */
export function createAssemblyViewer(canvas: HTMLCanvasElement, report: (message: string) => void, inspect: (itemId: string, path: string) => void) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
  const mesh = (plan: unknown, legacy?: {params:unknown;plan:unknown}) =>
    new Promise<MeshReply>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      worker.postMessage({ id, plan, ...legacy });
    });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e8ede5");
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  camera.up.set(0, 0, 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const controls = new OrbitControls(camera, canvas);
  scene.add(new THREE.AmbientLight("#ffffff", 2));
  const light = new THREE.DirectionalLight("#fff8e9", 3);
  light.position.set(80, -120, 240);
  scene.add(light);
  const group = new THREE.Group();
  scene.add(group);
  let frame: { min: number[]; max: number[] } | undefined;
  let selected: Set<string> | undefined;
  let selectedPath: string | undefined;
  let selectedItem: string | undefined;
  let isolated: Set<string> | undefined;
  let isolatedPath: string | undefined;
  let driveInspection: ReturnType<typeof createZDriveInspection> | undefined;
  let inspectionPaths = new Set<string>();
  let inspectionVisible = false;
  function clearInspection() {
    if(driveInspection){scene.remove(driveInspection.group);driveInspection.dispose();driveInspection=undefined;}
    inspectionPaths.clear();inspectionVisible=false;
  }

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

  let press: { x: number; y: number; id: number } | undefined;
  const raycaster = new THREE.Raycaster();
  const pointerDown = (event: PointerEvent) => {
    press = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : undefined;
  };
  const pointerUp = (event: PointerEvent) => {
    const start = press;
    press = undefined;
    if (!start || event.pointerId !== start.id || Math.hypot(event.clientX-start.x, event.clientY-start.y) > 4) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(2*(event.clientX-rect.left)/rect.width-1, 1-2*(event.clientY-rect.top)/rect.height), camera);
    const hits = raycaster.intersectObjects(group.children.filter(node => node.visible), true);
    for (const { object } of hits) {
      if (!(object instanceof THREE.Mesh)) continue;
      let node: THREE.Object3D | null = object;
      while (node && node.visible && node !== group) {
        if (node.parent === group && node.userData.itemId) {
          const groupHit = node.userData.pickGroup;
          const drill = groupHit && selectedItem === groupHit.id && selectedPath === groupHit.path;
          const owner = drill ? undefined : groupHit;
          inspect(owner?.id ?? node.userData.itemId, owner?.path ?? node.userData.path);
          return;
        }
        node = node.parent;
      }
    }
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);

  function topView() {
    if (!frame) return;
    const visible = new THREE.Box3().setFromObject(group);
    const center = visible.getCenter(new THREE.Vector3());
    const size = visible.getSize(new THREE.Vector3());
    const distance = 0.55 * Math.max(size.y, size.x / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
    controls.target.copy(center);
    camera.position.set(center.x, center.y-0.0001, visible.max.z+Math.max(distance,1));
    controls.update();
  }
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
    clearInspection();
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
      const id = node.userData.itemId as string;
      const path = node.userData.path as string;
      const inside = (scope?: string) => !scope || path === scope || path.startsWith(scope + "/");
      node.visible = (!isolated || isolated.has(id)) && inside(isolatedPath) && !(inspectionVisible && inspectionPaths.has(path));
      const dim = selected !== undefined && (!selected.has(id) || !inside(selectedPath));
      const picked = selected !== undefined && !dim;
      node.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const material = child.material as THREE.MeshStandardMaterial;
          child.userData.baseColor ??= material.color.getHex();
          material.color.setHex(picked ? 0x1676a3 : child.userData.baseColor);
          material.opacity = dim ? Math.min(0.12, child.userData.opacity) : picked ? Math.max(0.34, child.userData.opacity) : child.userData.opacity;
          material.transparent = material.opacity < 1;
          material.depthWrite = !material.transparent;
          material.needsUpdate = true;
        } else if (child instanceof THREE.LineSegments) {
          const edge = child.material as THREE.LineBasicMaterial;
          child.userData.baseOpacity ??= edge.opacity;
          edge.color.setHex(picked ? 0x154c68 : 0x2b2b2b);
          edge.opacity = picked ? 0.75 : dim ? 0.08 : child.userData.baseOpacity;
        }
      });
    }
  }

  /** Each distinct item meshed once, however many places use it. */
  async function meshItems(list: Placement[],legacy?: {params:unknown;plan:unknown}) {
    const items = new Map(list.map(({ item }) => [item.id, item]));
    const replies = await Promise.all([...items.values()].map((item) => mesh(item.geometry,legacy)));
    return new Map([...items.keys()].map((id, i) => [id, replies[i]]));
  }

  async function render(assembly: Assembly, artifactBase = "", legacy?: {params:unknown;plan:unknown}, artifacts:ArtifactRecord[]=[], signal?:AbortSignal, sources:Record<string,MeshSource>={}) {
    const current = ++version;
    isolated=undefined;
    isolatedPath=undefined;
    canvas.dataset.ready = "false";
    const list = placements(assembly);
    canvas.toggleAttribute("data-empty", !list.length);
    if (!list.length) {
      clear();
      frame = undefined;
      canvas.dataset.ready = "true";
      report("No geometry is available for this selection yet.");
      return;
    }
    report(`Building ${list.length} placed solids…`);
    const external=new Map<string,THREE.BufferGeometry>();
    try {
      const replies = await meshItems(list.filter(p=>!p.item.mesh),legacy);
      for(const {item} of list)if(item.mesh&&!external.has(item.id)){
        const src=sources[item.id] ?? attachedMesh(item);
        external.set(item.id,new STLLoader().parse(await verifiedArtifact(src?.base ?? artifactBase,item.mesh.path,src ? [src.artifact] : artifacts,signal,(url,init)=>fetch(appBase(location.pathname)+url,init))));
      }
      if (current !== version) return;
      clear();
      for (const placement of list) {
        const geometry=external.get(placement.item.id);
        if(!geometry){group.add(placedNode(placement,replies.get(placement.item.id) as MeshReply));continue;}
        const node=new THREE.Group();node.userData.pickGroup=placement.pickGroup;node.userData.itemId=placement.item.id;node.userData.path=placement.path;
        const solid=new THREE.Mesh(geometry.clone(),new THREE.MeshStandardMaterial({color:placement.item.color??"#8b9f91",roughness:0.65}));solid.userData.opacity=placement.item.opacity ?? 1;node.add(solid);
        if(placement.matrix){node.matrix.fromArray(placement.matrix);node.matrixAutoUpdate=false;}
        group.add(node);
      }
      for (const node of group.children) { if (node.matrixAutoUpdate) node.updateMatrix(); node.userData.restMatrix = node.matrix.clone(); }
      highlight();
      frame = assemblyBounds(list);
      reset();
      report(`${list.length} solids from ${replies.size + external.size} items · drag to rotate, scroll to zoom`);
      canvas.dataset.ready = "true";
    } catch (e) {
      if (current === version) {
        canvas.dataset.ready = "false";
        report((e as Error).message);
      }
    } finally {for(const geometry of external.values())geometry.dispose();}
  }

  return {
    render,
    reset,
    topView,
    inspectDrive(drives: ZDriveInspection[], visible: boolean) {
      clearInspection();
      if(visible && drives.length){
        driveInspection=createZDriveInspection(drives);inspectionVisible=true;
        inspectionPaths=new Set(drives.flatMap(d=>[d.axisPath,d.motorPath]));
        scene.add(driveInspection.group);
      }
      highlight();
      canvas.dataset.driveInspection=String(inspectionVisible);
    },
    previewPose(pose:Map<string,THREE.Matrix4>) {
      for (const node of group.children) {
        node.matrixAutoUpdate=false;
        node.matrix.copy(pose.get(node.userData.path) ?? node.userData.restMatrix);
        node.matrixWorldNeedsUpdate=true;
      }
    },
    /** View-only world Z displacement, restoring the original matrix on each call. */
    previewTranslation(paths: Set<string>, offset: number, rotations: PlacedRotation[] = [], axes?:Map<string,THREE.Vector3>) {
      let moved = 0;
      for (const node of group.children) {
        const rest = node.userData.restMatrix as THREE.Matrix4 | undefined;
        if (!rest) continue;
        node.matrixAutoUpdate = false;
        const translate=paths.has(node.userData.path);
        savedMotionMatrix(rest,offset,translate,rotations.filter(r=>r.path===node.userData.path),node.matrix,axes?.get(node.userData.path));
        if(translate)moved++;
        node.matrixWorldNeedsUpdate = true;
      }
      driveInspection?.update(offset);
      canvas.dataset.savedRotors=String(rotations.length);
      canvas.dataset.zDriveTurns=String(zDriveTurns(offset));
      canvas.dataset.motionOffset = String(offset);
      canvas.dataset.motionSolids = String(moved);
    },
    /** Show one item at full strength and fade the rest; undefined shows all. */
    isolate(items?: Set<string>, path?: string) {isolated=items;isolatedPath=path;highlight();},
    select(items?: Set<string>, path?: string, itemId?: string) {
      selectedItem = itemId;
      selected = items;
      selectedPath = path;
      highlight();
    },
    dispose() {
      version++;
      resize.disconnect();
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      controls.dispose();
      clear();
      renderer.dispose();
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("The 3D preview closed."));
      pending.clear();
    },
  };
}
