import { immediatePath, inspectionOffsets, type Occurrence } from "../lib/assembly-inspection";
import { openMeshCache, readMeshes, storeMeshes } from "./cad-mesh-cache";
import { hingeTransforms, type Hinge } from "../lib/inspection-placements";
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

function solidGeometry(reply:MeshReply) {
  const faces = new THREE.BufferGeometry();
  const edges = new THREE.BufferGeometry();
  syncFaces(faces, reply.faces);
  syncLines(edges, reply.edges);
  return {faces,edges};
}

function solidNode({faces,edges}:ReturnType<typeof solidGeometry>, color:string, opacity:number) {
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
function placedNode(placement: Placement, geometry:ReturnType<typeof solidGeometry>) {
  const { item } = placement;
  const node = solidNode(geometry, item.color ?? KIND_COLORS[item.kind] ?? "#888888", item.opacity ?? (item.kind === "printed" ? 0.3 : 1));
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
export function createAssemblyViewer(canvas: HTMLCanvasElement, report: (message: string) => void, inspect: (itemId: string, path: string) => void, clearSelection?: () => void) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const engine = import.meta.env.DEV ? cadWorkerURL : new URL(cadWorkerURL.split("/").at(-1)!, import.meta.url).href;
  const scope = appBase(location.pathname);
  const db = import.meta.env.DEV ? Promise.resolve(undefined) : openMeshCache();
  let worker:Worker | undefined;
  const pending = new Map<number, { resolve: (reply: MeshReply) => void; reject: (e: Error) => void }>();
  let id = 0;
  let version = 0;
  function cadWorker() {
    if (worker) return worker;
    worker=new Worker(engine,{type:"module"});
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
    return worker;
  }
  const mesh = (plan: unknown, legacy?: {params:unknown;plan:unknown}) =>
    new Promise<MeshReply>((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      cadWorker().postMessage({ id, plan, ...legacy });
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
  let dirty=true;
  const invalidate=()=>{dirty=true;};
  controls.addEventListener("change",invalidate);
  let frame: { min: number[]; max: number[] } | undefined;
  let selected: Set<string> | undefined;
  let selectedPath: string | undefined;
  let level: Occurrence | undefined;
  let offsets = new Map<string, THREE.Vector3>();
  let isolated: Set<string> | undefined;
  let isolatedPath: string | undefined;
  let hidden:ReadonlySet<string>=new Set(), openHinges:Hinge[]=[];
  let operationPose:Map<string,THREE.Matrix4>|undefined;
  function applyHinges() {
    invalidate();
    const transforms=hingeTransforms(openHinges,operationPose);
    for(const node of group.children) {
      const path:string=node.userData.path;
      node.matrix.copy(node.userData.motionMatrix ?? node.userData.restMatrix);
      for(const hinge of transforms) if(path===hinge.path || path.startsWith(hinge.path+"/")) node.matrix.premultiply(hinge.delta);
      const child = level && immediatePath(level.path, path);
      const delta = child && offsets.get(child);
      if (delta) node.matrix.premultiply(new THREE.Matrix4().makeTranslation(delta.x,delta.y,delta.z));
      node.matrixAutoUpdate=false;
      node.matrixWorldNeedsUpdate=true;
    }
  }
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
      invalidate();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  });
  resize.observe(canvas);
  renderer.setAnimationLoop(() => {
    if (canvas.offsetParent) {
      controls.update();
      if(dirty){renderer.render(scene,camera);dirty=false;}
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
          const child = level && immediatePath(level.path, node.userData.path);
          const owner = level?.children.find(entry => entry.path === child);
          inspect(owner?.item.id ?? node.userData.itemId, owner?.path ?? node.userData.path);
          return;
        }
        node = node.parent;
      }
    }
    clearSelection?.();
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);

  function visibleBounds() {
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    for (const node of group.children) if (node.visible) bounds.expandByObject(node);
    return bounds;
  }
  function topView() {
    if (!frame) return;
    const visible = visibleBounds();
    if (visible.isEmpty()) return;
    const center = visible.getCenter(new THREE.Vector3());
    const size = visible.getSize(new THREE.Vector3());
    const distance = 0.55 * Math.max(size.y, size.x / camera.aspect) / Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
    controls.target.copy(center);
    camera.position.set(center.x, center.y-0.0001, visible.max.z+Math.max(distance,1));
    controls.update();
  }
  function reset() {
    if (!frame) return;
    const bounds = visibleBounds();
    if (bounds.isEmpty()) return;
    const min = bounds.min.toArray(), max = bounds.max.toArray();
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
    invalidate();
    clearInspection();
    const geometries=new Set<THREE.BufferGeometry>();
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        geometries.add(child.geometry);
        (child.material as THREE.Material).dispose();
      }
    });
    group.clear();
    for(const geometry of geometries)geometry.dispose();
  }

  function highlight() {
    invalidate();
    const hiddenPaths=Array.from(hidden);
    for (const node of group.children) {
      const id = node.userData.itemId as string;
      const path = node.userData.path as string;
      const inside = (scope?: string) => !scope || path === scope || path.startsWith(scope + "/");
      node.visible = inside(level?.path) && (!isolated || isolated.has(id)) && inside(isolatedPath) && !hiddenPaths.some(inside) && !(inspectionVisible && inspectionPaths.has(path));
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
  async function meshItems(currentVersion:number,list: Placement[],legacy?: {params:unknown;plan:unknown}) {
    const items = new Map(list.map(({ item }) => [item.id, item]));
    if (!items.size) return new Map<string,MeshReply>();
    const cache = await db;
    const previous = await readMeshes(cache,scope,engine);
    if (currentVersion!==version) return new Map<string,MeshReply>();
    const current = new Map<string,Promise<MeshReply>>();
    let misses = 0;
    const replies = await Promise.all([...items.values()].map(async item=>{
      const key = JSON.stringify(legacy ?? item.geometry);
      let pending = current.get(key);
      if (!pending) {
        const saved = previous.get(key);
        if (!saved) misses++;
        pending = saved ? Promise.resolve(saved) : mesh(item.geometry,legacy);
        current.set(key,pending);
      }
      return [item.id,await pending] as const;
    }));
    if (misses && currentVersion===version) {
      const meshes = new Map(await Promise.all([...current].map(async ([key,result])=>[key,await result] as const)));
      storeMeshes(cache,scope,{engine,meshes});
    }
    return new Map(replies);
  }

  async function render(assembly: Assembly, artifactBase = "", legacy?: {params:unknown;plan:unknown}, artifacts:ArtifactRecord[]=[], signal?:AbortSignal, sources:Record<string,MeshSource>={}) {
    const current = ++version;
    operationPose=undefined;
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
      const meshes = new Map(list.filter(p=>p.item.mesh).map(p=>[p.item.id,p.item]));
      const queue = meshes.values();
      async function loadMeshes() {
        for (const item of queue) {
          if (current !== version) return;
          const src=sources[item.id] ?? attachedMesh(item);
          const bytes=await verifiedArtifact(src?.base ?? artifactBase,item.mesh!.path,src ? [src.artifact] : artifacts,signal,(url,init)=>fetch(appBase(location.pathname)+url,init));
          if (current !== version) return;
          external.set(item.id,new STLLoader().parse(bytes));
        }
      }
      const loading = Array.from({length:Math.min(6,meshes.size)},loadMeshes);
      // Wait for all parsers before disposing their geometries, even on failure.
      const [cad,...stls] = await Promise.allSettled([meshItems(current,list.filter(p=>!p.item.mesh),legacy),...loading] as const);
      if (cad.status==="rejected") throw cad.reason;
      for (const stl of stls) if(stl.status==="rejected")throw stl.reason;
      const replies=cad.value;
      if (current !== version) return;
      clear();
      const solids=new Map<MeshReply,ReturnType<typeof solidGeometry>>();
      for (const placement of list) {
        const geometry=external.get(placement.item.id);
        if(!geometry){
          const reply=replies.get(placement.item.id)!;
          let buffers=solids.get(reply);
          if(!buffers){buffers=solidGeometry(reply);solids.set(reply,buffers);}
          group.add(placedNode(placement,buffers));
          continue;
        }
        const node=new THREE.Group();node.userData.pickGroup=placement.pickGroup;node.userData.itemId=placement.item.id;node.userData.path=placement.path;
        const solid=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:placement.item.color??"#8b9f91",roughness:0.65}));solid.userData.opacity=placement.item.opacity ?? 1;node.add(solid);
        if(placement.matrix){node.matrix.fromArray(placement.matrix);node.matrixAutoUpdate=false;}
        group.add(node);
      }
      for (const node of group.children) { if (node.matrixAutoUpdate) node.updateMatrix(); node.userData.restMatrix = node.matrix.clone(); }
      highlight();
      applyHinges();
      frame = assemblyBounds(list);
      reset();
      report(`${list.length} solids from ${replies.size + external.size} items · drag to rotate, scroll to zoom`);
      canvas.dataset.ready = "true";
      external.clear(); // The scene now owns these buffers.
    } catch (e) {
      if (current === version) {
        canvas.dataset.ready = "false";
        report((e as Error).message);
      }
    } finally {for(const geometry of external.values())geometry.dispose();}
  }

  return {
    render,
    inspectLevel(next: Occurrence | undefined, amount: number) {
      level = next;
      offsets = next ? inspectionOffsets(next, amount) : new Map();
      applyHinges();
      highlight();
    },
    cameraPose() { return {position:camera.position.clone(), target:controls.target.clone()}; },
    restoreCamera(pose:{position:THREE.Vector3;target:THREE.Vector3}) {
      camera.position.copy(pose.position); controls.target.copy(pose.target); controls.update();
    },
    reset,
    topView,
    snapshot() {
      // Copy immediately after drawing. WebGL need not retain its framebuffer.
      renderer.render(scene,camera);
      const image=document.createElement("canvas");
      const scale=Math.min(1,640/Math.max(canvas.width,canvas.height));
      image.width=Math.max(1,Math.round(canvas.width*scale));
      image.height=Math.max(1,Math.round(canvas.height*scale));
      image.getContext("2d")!.drawImage(canvas,0,0,image.width,image.height);
      return image.toDataURL("image/jpeg",0.82);
    },
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
    inspectParts(paths:ReadonlySet<string>,hinges:Hinge[]) {
      const visibilityChanged=paths.size!==hidden.size || Array.from(paths).some(path=>!hidden.has(path));
      hidden=paths;openHinges=hinges;
      if(visibilityChanged)highlight();
      applyHinges();
    },
    previewPose(pose:Map<string,THREE.Matrix4>) {
      operationPose=pose;
      for(const node of group.children)node.userData.motionMatrix=pose.get(node.userData.path);
      applyHinges();
    },
    /** View-only world Z displacement, restoring the original matrix on each call. */
    previewTranslation(paths: Set<string>, offset: number, rotations: PlacedRotation[] = [], axes?:Map<string,THREE.Vector3>) {
      operationPose=undefined;
      let moved = 0;
      for (const node of group.children) {
        const rest = node.userData.restMatrix as THREE.Matrix4 | undefined;
        if (!rest) continue;
        node.matrixAutoUpdate = false;
        const translate=paths.has(node.userData.path);
        node.userData.motionMatrix ??= new THREE.Matrix4();
        savedMotionMatrix(rest,offset,translate,rotations.filter(r=>r.path===node.userData.path),node.userData.motionMatrix,axes?.get(node.userData.path));
        if(translate)moved++;
        node.matrixWorldNeedsUpdate = true;
      }
      applyHinges();
      driveInspection?.update(offset);
      canvas.dataset.savedRotors=String(rotations.length);
      canvas.dataset.zDriveTurns=String(zDriveTurns(offset));
      canvas.dataset.motionOffset = String(offset);
      canvas.dataset.motionSolids = String(moved);
    },
    /** Show one item at full strength and fade the rest; undefined shows all. */
    isolate(items?: Set<string>, path?: string) {isolated=items;isolatedPath=path;highlight();},
    select(items?: Set<string>, path?: string) {
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
      controls.removeEventListener("change",invalidate);
      controls.dispose();
      clear();
      renderer.dispose();
      worker?.terminate();
      void db.then(cache=>cache?.close());
      for (const p of pending.values()) p.reject(new Error("The 3D preview closed."));
      pending.clear();
    },
  };
}
