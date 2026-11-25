import type { Assembly } from "../lib/assembly";
import { inspectionPlacements, type Hinge } from "../lib/inspection-placements";

export function inspectionControls(
  view: Assembly,
  host: HTMLElement,
  restore: HTMLButtonElement,
  render: (hidden: ReadonlySet<string>, open: Hinge[]) => void,
  resetPose: () => void,
) {
  const { hinges } = inspectionPlacements(view);
  const hidden = new Set<string>(),
    open = new Set<string>();
  const angles = new Map<string, number>(),
    frames = new Map<string, number>();
  function draw() {
    render(
      new Set(hidden),
      Array.from(angles, ([path, angle]) => {
        const hinge = hinges.get(path)!;
        return { ...hinge, joint: { ...hinge.joint, openDegrees: angle } };
      }),
    );
  }
  function swing(path: string) {
    const existing = frames.get(path);
    if (existing !== undefined) cancelAnimationFrame(existing);
    const from = angles.get(path) ?? 0,
      full = hinges.get(path)!.joint.openDegrees;
    const to = open.has(path) ? full : 0;
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 420 * Math.abs((to - from) / full);
    const start = performance.now();
    const tick = (now: number) => {
      const t = duration ? Math.min(1, Math.max(0, (now - start) / duration)) : 1;
      const value = from + (to - from) * t;
      if (value) angles.set(path, value);
      else angles.delete(path);
      draw();
      if (t < 1) frames.set(path, requestAnimationFrame(tick));
      else frames.delete(path);
    };
    tick(start);
  }
  function stop() {
    for (const frame of frames.values()) cancelAnimationFrame(frame);
    frames.clear();
  }
  function apply() {
    draw();
    restore.hidden = !(hidden.size || open.size);
  }
  let currentPath: string | undefined;
  function select(path?: string) {
    currentPath = path;
    host.replaceChildren();
    if (!path || path === view.rootId) return;
    const occurrence = path;
    function toggle(state: Set<string>, activate: string, deactivate: string) {
      const button = document.createElement("button");
      const sync = () => {
        button.textContent = state.has(occurrence) ? deactivate : activate;
      };
      sync();
      button.onclick = () => {
        if (state.has(occurrence)) state.delete(occurrence);
        else state.add(occurrence);
        if (state === open) swing(occurrence);
        apply();
        sync();
      };
      host.append(button);
    }
    toggle(hidden, "Hide component", "Show component");
    if (hinges.has(path)) toggle(open, "Open hinge", "Close hinge");
  }
  restore.onclick = () => {
    stop();
    hidden.clear();
    open.clear();
    angles.clear();
    resetPose();
    apply();
    select(currentPath);
  };
  apply();
  return { select, stop };
}
