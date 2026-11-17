import * as THREE from 'three';
import {Z_PITCH_RADIUS as radius, zDriveTurns, type ZDriveInspection} from '../lib/artera-drive-review';

/** Proposed cutaway overlay only. Does not add purchased parts or change CAD/BOM.
 * Amber bodies indicate assumed integration datums. Rotation about the rail's
 * transverse X axis follows the selected axis's documented 70 mm/rev ratio.
 */
export function createZDriveInspection(drives: ZDriveInspection[]) {
 const group=new THREE.Group();
 const attachments: {node:THREE.Group; z:number}[]=[];
 const rotors: THREE.Group[]=[], markers: {node:THREE.Mesh;drive:ZDriveInspection;phase:number}[]=[];
 const metal=new THREE.MeshStandardMaterial({color:'#e0a32b',roughness:0.65});
 const belt=new THREE.MeshStandardMaterial({color:'#202f37',side:THREE.DoubleSide});
 const mark=new THREE.MeshStandardMaterial({color:'#ffdd52'});
 const body=new THREE.MeshStandardMaterial({color:'#db8b26',transparent:true,opacity:0.55});
 const materials=[metal,belt,mark,body];
 const box=(size:number[],position:number[],material:THREE.Material)=>{
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size as [number,number,number]),material);mesh.position.set(...position as [number,number,number]);group.add(mesh);return mesh;
 };
 const cylinder=(r:number,length:number,x:number,y:number,z:number,spoke=false)=>{
  const rotor=new THREE.Group();rotor.position.set(x,y,z);
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,length,32),metal);mesh.rotation.z=Math.PI/2;rotor.add(mesh);
  if(spoke){const stripe=new THREE.Mesh(new THREE.BoxGeometry(length+1,2,r*1.5),mark);stripe.position.z=r/4;rotor.add(stripe);}
  group.add(rotor);rotors.push(rotor);return rotor;
 };
 function point(d:ZDriveInspection,distance:number) {
  const straight=d.high-d.low,arc=Math.PI*radius,total=2*straight+2*arc;
  let s=((distance%total)+total)%total;
  if(s<straight)return [d.y+radius,d.low+s];s-=straight;
  if(s<arc){const a=s/radius;return [d.y+radius*Math.cos(a),d.high+radius*Math.sin(a)];}s-=arc;
  if(s<straight)return [d.y-radius,d.high-s];s-=straight;
  const a=Math.PI+s/radius;return [d.y+radius*Math.cos(a),d.low+radius*Math.sin(a)];
 }
 for(const d of drives){
  const envelope=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(74,45,d.high-d.low+52)),new THREE.LineBasicMaterial({color:'#68767d'}));
  envelope.position.set(d.x,d.y+0.5,(d.low+d.high)/2);group.add(envelope);
  // Red connector is an unresolved carriage attachment, not a fabricated clamp.
  const attachment=new THREE.Group();attachment.position.set(d.x,d.y+radius,d.carriageZ);
  const line=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(24,Math.max(2,Math.abs(d.carriageY-(d.y+radius))),12)),new THREE.LineBasicMaterial({color:'#c42a2a'}));
  line.position.y=(d.carriageY-(d.y+radius))/2;attachment.add(line);group.add(attachment);attachments.push({node:attachment,z:d.carriageZ});
  // Axial X belt width = 16 mm; the ribbon is the pitch surface, not tooth CAD.
  const straight=d.high-d.low,total=2*straight+2*Math.PI*radius,vertices:number[]=[];
  const samples=256;
  for(let i=0;i<samples;i++){
   const a=point(d,total*i/samples),b=point(d,total*(i+1)/samples);
   vertices.push(d.x-8,...a,d.x+8,...a,d.x+8,...b,d.x-8,...a,d.x+8,...b,d.x-8,...b);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();group.add(new THREE.Mesh(geometry,belt));
  cylinder(radius,16,d.x,d.y,d.low,true);cylinder(radius,16,d.x,d.y,d.high,true);
  const dir=d.direction;
  // Axis stub (10 x 20), coupling (32 x 32, 8/10 bores), motor shaft (8 x 21).
  // Shaft axes are collinear; flange face at +41 is a proposed datum only.
  cylinder(5,Math.abs(d.side-d.x)+20,(d.x+d.side+dir*20)/2,d.y,d.high,true);
  cylinder(16,32,d.side+dir*20,d.y,d.high,true);
  cylinder(4,21,d.side+dir*30.5,d.y,d.high,true);
  box([88,57,57],[d.side+dir*85,d.y,d.high],body);
  // Red wireframe shows the unverified flange/support span, not a real bracket.
  const support=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(41,65,65)),new THREE.LineBasicMaterial({color:'#c42a2a'}));support.position.set(d.side+dir*20.5,d.y,d.high);group.add(support);
  for(let i=0;i<32;i++){const node=box([18,3,3],[d.x,d.y,d.low],mark);markers.push({node,drive:d,phase:i*total/32});}
 }
 function update(offset:number){
  // +X rotation lifts the +Y belt strand. Mirrored motor faces use opposite local senses.
  const angle=zDriveTurns(offset)*2*Math.PI;
  for(const rotor of rotors)rotor.rotation.x=angle;
  for(const a of attachments)a.node.position.z=a.z+offset;
  for(const m of markers){const [y,z]=point(m.drive,m.phase+offset);m.node.position.set(m.drive.x,y,z);}
 }
 update(0);
 return {group,update,dispose(){group.traverse(node=>{if(node instanceof THREE.Mesh||node instanceof THREE.LineSegments){node.geometry.dispose();if(node instanceof THREE.LineSegments)(node.material as THREE.Material).dispose();}});for(const m of materials)m.dispose();group.clear();}};
}
