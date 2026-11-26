import { operationPrograms, resolveMotionParameters } from "./operation-program";
import { Matrix4, Vector3 } from "three";
import { placements, type Assembly } from "./assembly";
import type { Operation, Joint } from "./operation-schema";

type Node = {item:Assembly["items"][number]; path:string; parent:string; rest:Matrix4; local:Matrix4; joint?:Joint};
type Mount = {path:string; label:string; operation:Operation};
const identity = new Matrix4();

function sample(keys:Operation["tracks"][number]["keys"], time:number) {
  const next = keys.findIndex(k=>k.time>time);
  if (next < 0) return keys[keys.length-1].value;
  if (!next) return keys[0].value;
  const a=keys[next-1], b=keys[next];
  return a.value+(b.value-a.value)*(time-a.time)/(b.time-a.time);
}

export function jointMatrix(joint:Joint, value:number) {
  const axis = new Vector3(...joint.axis);
  if (joint.kind==="prismatic") return new Matrix4().makeTranslation(axis.multiplyScalar(value));
  const pivot = new Vector3(...(joint.pivot ?? [0,0,0]));
  return new Matrix4().makeTranslation(pivot)
    .multiply(new Matrix4().makeRotationAxis(axis,value*Math.PI/180))
    .multiply(new Matrix4().makeTranslation(pivot.negate()));
}

export function installedOperations(assembly:Assembly) {
  const view={...assembly,items:assembly.items.map(item=>resolveMotionParameters(item,assembly.configurations))};
  const nodes = new Map<string,Node>();
  const mounts:Mount[] = [];
  if (view.items.some(item=>item.operations?.length)) placements(view,{onVisit(item,path,rest,usage) {
    const parent = path.slice(0,Math.max(0,path.lastIndexOf("/")));
    const local = (nodes.get(parent)?.rest ?? identity).clone().invert().multiply(rest);
    nodes.set(path,{item,path,parent,rest,local,joint:usage?.joint});
    for (const operation of item.operations ?? []) mounts.push({operation,path,label:item.name+" · "+operation.name});
  }});
  const programs=operationPrograms(view.items);
  return mounts.map(mount=>{
    const {operation}=mount;
    const absolute = (relative:string) => mount.path+"/"+relative;
    const program=programs.compile(nodes.get(mount.path)!.item,operation);
    const tracks=new Map([...program.tracks].map(([path,keys])=>[absolute(path),keys]));
    type Attachment = {time:number; carrier:string; offset:Matrix4};
    const attachments = new Map<string,Attachment[]>();
    // Walk the installed parent frames, including any carrier that took over at a handoff.
    function at(path:string,time:number,cache:Map<string,Matrix4>):Matrix4 {
      const cached=cache.get(path);
      if (cached) return cached;
      const node=nodes.get(path);
      if (!node) throw Error("Missing operation placement "+path);
      const event=attachments.get(path)?.findLast(e=>e.time<=time);
      let matrix:Matrix4;
      if (event) matrix=at(event.carrier,time,cache).clone().multiply(event.offset);
      else {
        matrix=node.parent ? at(node.parent,time,cache).clone().multiply(node.local) : node.rest.clone();
        const keys=tracks.get(path);
        if (keys && node.joint) matrix.multiply(jointMatrix(node.joint,sample(keys,time)));
      }
      cache.set(path,matrix);
      return matrix;
    }
    for (const e of program.events) {
      const path=absolute(e.propPath);
      const carrier=e.carrierPath ? absolute(e.carrierPath) : mount.path;
      const cache=new Map<string,Matrix4>();
      const offset=at(carrier,e.time,cache).clone().invert().multiply(at(path,e.time,cache));
      const events=attachments.get(path) ?? [];
      events.push({time:e.time,carrier,offset});
      attachments.set(path,events);
    }
    function checks() {
      return program.checks.map(check=>{
        const path=absolute(check.path);
        const joint=nodes.get(path)?.joint;
        let expected:number[], actual:number[], unit:"mm"|"deg";
        if(check.kind==="joint") {
          const keys=tracks.get(path);
          expected=[check.expected];
          actual=[keys ? sample(keys,check.time) : 0];
          unit=joint?.kind==="revolute"?"deg":"mm";
        } else {
          const cache=new Map<string,Matrix4>();
          const frame=check.frame ? absolute(check.frame) : mount.path;
          const local=at(frame,check.time,cache).clone().invert().multiply(at(path,check.time,cache));
          if(check.kind==="position") {
            expected=check.expected;
            actual=new Vector3(...(check.point ?? [0,0,0])).applyMatrix4(local).toArray();
            unit="mm";
          } else if(check.kind==="distance") {
            const a=new Vector3(...(check.point ?? [0,0,0])).applyMatrix4(at(path,check.time,cache));
            const b=new Vector3(...(check.otherPoint ?? [0,0,0])).applyMatrix4(at(absolute(check.otherPath),check.time,cache));
            actual=[a.distanceTo(b)]; expected=[check.expected]; unit="mm";
          } else {
            const angle=new Vector3(...check.axis).transformDirection(local).angleTo(new Vector3(...check.expected));
            actual=[angle*180/Math.PI]; expected=[0]; unit="deg";
          }
        }
        const passed=Math.hypot(...actual.map((v,i)=>v-expected[i]))<=check.tolerance+1e-9;
        return {label:check.label,time:check.time,expected,actual,tolerance:check.tolerance,passed,unit};
      });
    }
    return {...mount, checks, pose(time:number) {
      const cache=new Map<string,Matrix4>();
      for (const path of nodes.keys()) if (path.startsWith(mount.path+"/")) at(path,time,cache);
      return cache;
    }};
  });
}
