import { Matrix4, Vector3 } from "three";
import { placements, type Assembly } from "./assembly";
import type { Operation, Joint } from "./operation-schema";

type Node = {path:string; parent:string; rest:Matrix4; local:Matrix4; joint?:Joint};
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

export function installedOperations(view:Assembly) {
  const nodes = new Map<string,Node>();
  const mounts:Mount[] = [];
  if (view.items.some(item=>item.operations?.length)) placements(view,{onVisit(item,path,rest,usage) {
    const parent = path.slice(0,Math.max(0,path.lastIndexOf("/")));
    const local = (nodes.get(parent)?.rest ?? identity).clone().invert().multiply(rest);
    nodes.set(path,{path,parent,rest,local,joint:usage?.joint});
    for (const operation of item.operations ?? []) mounts.push({operation,path,label:item.name+" · "+operation.name});
  }});
  return mounts.map(mount=>{
    const {operation}=mount;
    const absolute = (relative:string) => mount.path+"/"+relative;
    const tracks = new Map(operation.tracks.map(t=>[absolute(t.path),t.keys]));
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
    for (const e of operation.handoffs ?? []) {
      const path=absolute(e.propPath);
      const carrier=e.carrierPath ? absolute(e.carrierPath) : mount.path;
      const cache=new Map<string,Matrix4>();
      const offset=at(carrier,e.time,cache).clone().invert().multiply(at(path,e.time,cache));
      const events=attachments.get(path) ?? [];
      events.push({time:e.time,carrier,offset});
      attachments.set(path,events);
    }
    return {...mount, pose(time:number) {
      const cache=new Map<string,Matrix4>();
      for (const path of nodes.keys()) if (path.startsWith(mount.path+"/")) at(path,time,cache);
      return cache;
    }};
  });
}
