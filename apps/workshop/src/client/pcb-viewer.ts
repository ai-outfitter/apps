import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type CameraView = "perspective" | "top" | "bottom";
export interface PcbViewer { view(mode: CameraView): void; toggleSpin(): boolean }

/** Runs `cleanup` when the page's signal aborts, or now if it already has. */
function onAbort(signal: AbortSignal, cleanup: () => void) {
  if (signal.aborted) cleanup();
  else signal.addEventListener("abort", cleanup, { once: true });
}

function disposeObject(root: THREE.Object3D) {
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

/** Shows an exported board GLB in `host`. Every resource is released when
 * `signal` aborts, including when it aborts while the model is parsing. */
export async function mountPcbViewer(host: HTMLElement, glb: ArrayBuffer, signal: AbortSignal): Promise<PcbViewer | undefined> {
  if (signal.aborted) return undefined;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  const observer = new ResizeObserver(() => resize());
  let released = false;
  const releaseContext = () => {
    if (released) return;
    released = true;
    renderer.dispose();
    renderer.forceContextLoss();
  };
  onAbort(signal, () => {
    observer.disconnect();
    renderer.setAnimationLoop(null);
    controls.dispose();
    disposeObject(scene);
    releaseContext();
    renderer.domElement.remove();
    delete host.dataset.ready;
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x111d26);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x557783, 3));
  for (const [x, y, z] of [[2, 3, 4], [-3, 1, -2]]) {
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(x, y, z);
    scene.add(light);
  }
  controls.enableDamping = true;
  controls.autoRotateSpeed = 0.5;

  const gltf = await new GLTFLoader().parseAsync(glb, "").catch((e: unknown) => {
    // Release the GPU context now rather than at the next navigation.
    releaseContext();
    throw e;
  });
  if (signal.aborted) {
    disposeObject(gltf.scene);
    return undefined;
  }
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  gltf.scene.position.sub(box.getCenter(new THREE.Vector3()));
  const distance = Math.max(size.x, size.y, size.z) * 1.65;

  let dirty = true;
  controls.addEventListener("change", () => { dirty = true; });
  function resize() {
    dirty = true;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    camera.updateProjectionMatrix();
  }
  function view(mode: CameraView) {
    camera.up.set(0, 1, 0);
    if (mode === "top") { camera.up.set(0, 0, -1); camera.position.set(0, distance, 0); }
    else if (mode === "bottom") { camera.up.set(0, 0, 1); camera.position.set(0, -distance, 0); }
    else camera.position.set(distance * 0.65, distance * 0.85, distance * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    dirty = true;
  }

  host.append(renderer.domElement);
  observer.observe(host);
  resize();
  view("perspective");
  renderer.setAnimationLoop(() => {
    controls.update();
    if (!dirty) return;
    renderer.render(scene, camera);
    dirty = false;
    host.dataset.ready = "true";
  });
  return { view, toggleSpin: () => (controls.autoRotate = !controls.autoRotate) };
}
