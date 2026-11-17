import { placements, type Assembly } from './assembly';

// igus DrylinSlideTables.pdf pp. 22.11–22.12: 70 mm/rev, 16 mm belt,
// 74 x 45 profile, lt=52 end block, ha=22 shaft height, l2=20, d2=10.
// Internal pulley position at end-block midpoint and motor flange spacing
// below are integration assumptions, NOT a supplier CAD model.
export const Z_TRAVEL_PER_REV = 70;
export const Z_PITCH_RADIUS = Z_TRAVEL_PER_REV / (2 * Math.PI);
export const zDriveTurns = (travel: number) => travel / Z_TRAVEL_PER_REV;

export type ZDriveInspection = {
 axisPath: string; motorPath: string; x: number; y: number; low: number; high: number;
 carriageZ: number; carriageY: number; side: number; direction: 1 | -1;
};

export function arteraDriveReview(assembly: Assembly, view: Assembly) {
 const list=placements(view);
 const axes=list.filter(p=>p.item.number==='MOTION-M001').sort((a,b)=>a.position[0]-b.position[0]);
 const motors=list.filter(p=>p.item.number==='MOTION-U005').sort((a,b)=>a.position[0]-b.position[0]);
 const carriages=list.filter(p=>p.item.number==='MOTION-U001').sort((a,b)=>a.position[0]-b.position[0]);
 const missing = ['MOTION-U003','MOTION-U014','MOTION-U007'].filter(number=>{
  const item=assembly.items.find(i=>i.number===number);
  return !item || !(item.geometry || item.mesh);
 });
 const findings = [
  'Z mounting flange, coupling engagement, carriage belt attachment and independent load retention are not geometrically verified.',
  'The saved Z motor bodies do not define a verified coaxial motor-to-axis connection. Cutaway motor placement is a proposed correction.',
  'X belt, idler and carriage clamp are incomplete; X travel is not demonstrated.',
  'Y belt routing is modeled, but tooth engagement, tension, fasteners and loaded operation remain unverified.',
  'Two Z motors require homing, synchronization and a power-loss retention test. No hardware evidence is attached.',
 ];
 const drives: ZDriveInspection[]=[];
 // Never dress an unrelated axis (or changed supplier envelope) as this mechanism.
 if(axes.length===2 && motors.length===2 && carriages.length===2 && axes.every(p=>p.item.mpn==='ZLW-1040-02-S-100-L-1500') && motors.every(p=>p.item.mpn==='23HS22-2804D-B200')) {
  for(let i=0;i<2;i++) {
   const axis=axes[i], motor=motors[i];
   if(axis.rotation || motor.rotation)continue;
   const [x,y,z]=axis.position, direction=i===0?1:-1;
   drives.push({axisPath:axis.path,motorPath:motor.path,x:x+37,y:y+22,low:z+26,high:z+1704-26,carriageZ:carriages[i].position[2]+50,carriageY:carriages[i].position[1]+12,side:x+(direction===1?74:0),direction});
  }
 }
 return {status:'incomplete' as const,findings,missing,drives};
}
