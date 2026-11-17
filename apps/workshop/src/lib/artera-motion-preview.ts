import { placements, type Assembly } from './assembly';

/** Visualization adapter for the Artera configure.py rack, not a joint solver.
 * Its retracted Y pose is retained. The tool datum is 114 mm above the beam;
 * configure.py targets tray top + 10 mm. No physical motion is commanded.
 */
export function arteraMotionPreview(assembly: Assembly, view: Assembly, parameters: Record<string, unknown>) {
 const byNumber = new Map(assembly.items.map(item => [item.number, item]));
 const robot = byNumber.get('MOTION-A001'), root = byNumber.get('POD-A001');
 if (!robot || !root || ![root.id, robot.id].includes(view.rootId ?? '')) return;
 const shelf = byNumber.get('POD-A003'), beam = byNumber.get('MOTION-M002');
 const mount = root.uses.find(use => use.itemId === robot.id);
 const beamUse = robot.uses.find(use => use.itemId === beam?.id);
 const thickness = parameters.shelf_thickness, trayDepth = parameters.tray_depth;
 if (!shelf || !mount || !beamUse || typeof thickness !== 'number' || typeof trayDepth !== 'number') return;
 const levels = root.uses.filter(use => use.itemId === shelf.id).map(use => ({
  label: use.refdes || 'Shelf', offset: use.position[2] + thickness + trayDepth + 10 - 114 - mount.position[2] - beamUse.position[2],
 })).sort((a,b) => a.offset-b.offset);
 if (levels.length < 2 || levels.some(level=>!Number.isFinite(level.offset))) return;
 const movingNumbers = new Set(['MOTION-U001','MOTION-M002','MOTION-U009','MOTION-U018','MOTION-M110','MOTION-M111','MOTION-M005','MOTION-A010','MOTION-A011','MOTION-A012','MOTION-A014']);
 const movingUses = robot.uses.filter(use=>movingNumbers.has(assembly.items.find(item=>item.id===use.itemId)?.number ?? ''));
 // Match usage paths, not part IDs: a shared part in a fixed mount must stay fixed.
 const paths = new Set(placements(view).filter(p=>movingUses.some(use=>p.path.includes(`/${use.id}#`))).map(p=>p.path));
 return paths.size ? {levels, paths} : undefined;
}
