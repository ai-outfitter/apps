import sax from "sax";

type Point = [number,number,number];
type Transform = number[];
type Mesh = { vertices:number[]; triangles:number[] };
type Component = { path?:string; id:string; transform:Transform };
type ModelObject = Mesh & { components:Component[] };
type Build = { id:string; transform:Transform; printable:boolean };
const rootPath = "3D/3dmodel.model";
const identity = [1,0,0,0,1,0,0,0,1,0,0,0];
const toleranceMm = 0.0001;
const maxTriangles = 100_000;
const maxCoordinate = 100_000;
function stop(message:string):never { throw new Response(message,{status:400}); }

type Element = { name:string; attributes:Record<string,string> };
function xml(data:string,onOpen:(element:Element,parents:Element[])=>void,onClose?:(element:Element,parents:Element[])=>void) {
  const reader = sax.parser(true,{xmlns:false});
  const stack:Element[] = [];
  reader.ondoctype = () => stop("External declarations are unsupported in a slice package");
  reader.onerror = () => stop("Invalid 3MF XML");
  reader.onopentag = tag => {
    if (stack.length>=32) stop("3MF structure is too deep");
    const element = {name:tag.name,attributes:tag.attributes as Record<string,string>};
    onOpen(element,stack);
    stack.push(element);
  };
  reader.onclosetag = () => {
    const element = stack.pop();
    if (element) onClose?.(element,stack);
  };
  reader.write(data).close();
}

function checkedCoordinate(value:number):number {
  if (!Number.isFinite(value) || Math.abs(value)>maxCoordinate) stop("Invalid 3MF or STL coordinate");
  return value;
}

function transform(raw:string|undefined):Transform {
  if (raw===undefined) return identity;
  const values = raw.trim().split(/\s+/).map(Number);
  if (values.length!==12 || values.some(value=>!Number.isFinite(value))) stop("Invalid 3MF transform");
  return values;
}

function apply(point:Point, matrix:Transform):Point {
  const [x,y,z] = point;
  return [
    checkedCoordinate(x*matrix[0]+y*matrix[3]+z*matrix[6]+matrix[9]),
    checkedCoordinate(x*matrix[1]+y*matrix[4]+z*matrix[7]+matrix[10]),
    checkedCoordinate(x*matrix[2]+y*matrix[5]+z*matrix[8]+matrix[11]),
  ];
}

function confirmPlacement(matrix:Transform) {
  const dot = (a:number,b:number) => matrix[a]*matrix[b]+matrix[a+1]*matrix[b+1]+matrix[a+2]*matrix[b+2];
  const [a,b,c,d,e,f,g,h,i] = matrix;
  const det = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if (Math.abs(det-1)>1e-6 || [0,3,6].some(axis=>Math.abs(dot(axis,axis)-1)>1e-6) ||
      [dot(0,3),dot(0,6),dot(3,6)].some(value=>Math.abs(value)>1e-6)) stop("A sliced instance scales or mirrors its source geometry");
}

function readModel(data:string) {
  let object:ModelObject|undefined;
  const objects = new Map<string,ModelObject>();
  const build:Build[] = [];
  let triangles = 0, vertices = 0;
  const sections=new Set<string>();
  xml(data,({name,attributes},parents) => {
    const parent = parents.at(-1)?.name;
    if (!parents.length && (name!=="model" || (attributes.unit??"millimeter")!=="millimeter")) stop("Slice verification requires a millimeter 3MF model");
    if (parents.length===1 && (name==="build" || name==="resources")) {
      if (sections.has(name)) stop("Repeated 3MF model section");
      sections.add(name);
    }
    if (name==="object" && parent==="resources" && parents.length===2) {
      if (!/^\d+$/.test(attributes.id) || objects.has(attributes.id)) stop("Invalid or repeated model object ID");
      object = {vertices:[],triangles:[],components:[]};
      objects.set(attributes.id,object);
    }
    if (name==="vertex" && parent==="vertices" && parents.at(-2)?.name==="mesh" && parents.length===5 && object) {
      if (++vertices>3*maxTriangles) stop("Slice geometry exceeds the verification limit");
      object.vertices.push(...["x","y","z"].map(axis=>checkedCoordinate(Number(attributes[axis]))));
    }
    if (name==="triangle" && parent==="triangles" && parents.at(-2)?.name==="mesh" && parents.length===5 && object) {
      if (++triangles>maxTriangles) stop("Slice geometry exceeds the verification limit");
      object.triangles.push(...["v1","v2","v3"].map(key=>/^\d+$/.test(attributes[key])?Number(attributes[key]):-1));
    }
    if (name==="component" && parent==="components" && parents.length===4 && object) {
      if (object.components.length>=100) stop("Too many 3MF components");
      object.components.push({path:attributes["p:path"]?.replace(/^\//,""),id:attributes.objectid,transform:transform(attributes.transform)});
    }
    if (name==="item" && parent==="build" && parents.length===2) {
      if (build.length>=1000 || attributes["p:path"]) stop("Unsupported 3MF build instance");
      build.push({id:attributes.objectid,transform:transform(attributes.transform),printable:attributes.printable!=="0"});
    }
  },({name},parents)=>{
    if (name==="object" && parents.at(-1)?.name==="resources" && parents.length===2) object=undefined;
  });
  return {objects,build};
}

type PlateInstance = { objectId:string; instanceId:number; identifyId:string };
function plateInstances(data:string) {
  const plates = new Map<number,PlateInstance[]>();
  let plate:PlateInstance[]|undefined;
  let plateIndex = NaN;
  let gcodePath:string|undefined;
  let instance:Record<string,string>|undefined;
  xml(data,({name,attributes},parents)=>{
    const parent = parents.at(-1)?.name;
    if (!parents.length && name!=="config") stop("Invalid 3MF model settings root");
    if (name==="plate" && parent==="config" && parents.length===1) {
      plate=[]; plateIndex=NaN; gcodePath=undefined;
    }
    if (name==="model_instance" && parent==="plate") instance={};
    if (name==="metadata" && parent==="model_instance" && instance) {
      if (["object_id","instance_id","identify_id"].includes(attributes.key)) {
        if (attributes.key in instance) stop("Repeated plate instance identity");
        instance[attributes.key]=attributes.value;
      }
    }
    if (name==="metadata" && parent==="plate" && attributes.key==="plater_id") plateIndex=Number(attributes.value);
    if (name==="metadata" && parent==="plate" && attributes.key==="gcode_file") gcodePath=attributes.value;
  },({name},parents)=>{
    if (name==="model_instance" && parents.at(-1)?.name==="plate" && plate && instance) {
      const {object_id:objectId, instance_id:ordinal, identify_id:identifyId} = instance;
      if (!/^\d+$/.test(objectId) || !/^\d+$/.test(ordinal) || !/^\d+$/.test(identifyId)) stop("A plate instance has no verifiable identity");
      plate.push({objectId,instanceId:Number(ordinal),identifyId});
      instance=undefined;
    }
    if (name==="plate" && parents.at(-1)?.name==="config" && plate) {
      if (gcodePath===`Metadata/plate_${plateIndex}.gcode`) {
        if (plates.has(plateIndex)) stop("Repeated 3MF plate identity");
        plates.set(plateIndex,plate);
      }
      plate=undefined;
    }
  });
  return plates;
}

/** Bind native plate-instance IDs to the same resource model used by the 3MF build. */
export function slicedGeometry(entries:Record<string,Uint8Array>) {
  const config = entries["Metadata/model_settings.config"];
  if (!entries[rootPath] || !config) stop("3MF is missing model or plate-instance geometry");
  const decoder = new TextDecoder();
  const models = new Map<string,ReturnType<typeof readModel>>();
  const load = (path:string) => {
    let model = models.get(path);
    if (!model) {
      if (!entries[path]) stop("3MF component refers to an unavailable resource");
      model=readModel(decoder.decode(entries[path]));
      models.set(path,model);
    }
    return model;
  };
  const root = load(rootPath);
  const placements = new Map<string,Build[]>();
  let totalTriangles = 0;
  for (const instance of root.build) {
    const objects=placements.get(instance.id)??[];
    objects.push(instance);
    placements.set(instance.id,objects);
  }
  function triangles(path:string,id:string,chain:Transform[],vertices:number[]):void {
    const object = load(path).objects.get(id);
    if (!object || chain.length>8) return stop("Unsupported or cyclic 3MF model structure");
    if (object.components.length) {
      if (object.vertices.length || object.triangles.length) stop("A 3MF model mixes components and mesh geometry");
      for (const component of object.components) triangles(component.path??path,component.id,[component.transform,...chain],vertices);
      return;
    }
    totalTriangles += object.triangles.length/3;
    if (!object.triangles.length || totalTriangles>maxTriangles) stop("Slice geometry exceeds the verification limit or is empty");
    for (const index of object.triangles) {
      if (!Number.isSafeInteger(index) || index<0 || index>=object.vertices.length/3) stop("Invalid vertex index in 3MF");
      const start=index*3;
      let point:Point=[object.vertices[start],object.vertices[start+1],object.vertices[start+2]];
      for (const matrix of chain) point=apply(point,matrix);
      vertices.push(...point);
    }
  }
  const plates = plateInstances(decoder.decode(config));
  const usedPlacements = new Set<Build>();
  const faces = new Map<string,number[]>();
  const output = new Map<number,Map<string,number[]>>();
  for (const [index,instances] of plates) {
    const geometries = new Map<string,number[]>();
    for (const instance of instances) {
      const placement = placements.get(instance.objectId)?.[instance.instanceId];
      if (!placement?.printable || usedPlacements.has(placement) || geometries.has(instance.identifyId)) stop("Invalid or duplicate 3MF plate placement");
      confirmPlacement(placement.transform);
      usedPlacements.add(placement);
      let vertices = faces.get(instance.objectId);
      if (!vertices) {
        vertices=[];
        triangles(rootPath,instance.objectId,[],vertices);
        faces.set(instance.objectId,vertices);
      }
      geometries.set(instance.identifyId,vertices);
    }
    output.set(index,geometries);
  }
  if (usedPlacements.size !== root.build.filter(instance=>instance.printable).length)
    stop("The slice plates do not identify every printable model instance");
  return output;
}

function stlTriangles(bytes:Uint8Array) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const count = bytes.length>=84 ? view.getUint32(80,true) : 0;
  const data:number[] = [];
  if (count && 84+50*count===bytes.length) {
    if (count>maxTriangles) stop("STL geometry exceeds the verification limit");
    for (let start=84;start<bytes.length;start+=50) {
      for (let offset=start+12;offset<start+48;offset+=4) data.push(checkedCoordinate(view.getFloat32(offset,true)));
    }
    return data;
  }
  const text = new TextDecoder("utf-8",{fatal:true}).decode(bytes).trim();
  if (!/^solid\b/i.test(text) || !/\bendsolid\b/i.test(text)) stop("Unsupported STL encoding");
  for (const [,x,y,z] of text.matchAll(/^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/gmi)) {
    if (data.length>=maxTriangles*9) stop("STL geometry exceeds the verification limit");
    data.push(checkedCoordinate(Number(x)),checkedCoordinate(Number(y)),checkedCoordinate(Number(z)));
  }
  const facets = [...text.matchAll(/^\s*endfacet\s*$/gmi)].length;
  if (!facets || data.length!==facets*9) stop("Invalid ASCII STL facets");
  return data;
}

function minCorner(vertices:number[]):Point {
  const min:Point=[Infinity,Infinity,Infinity];
  for (let i=0;i<vertices.length;i++) min[i%3]=Math.min(min[i%3],vertices[i]);
  return min;
}

function triangleKey(a:number,b:number,c:number) {
  return a<=b && a<=c ? `${a},${b},${c}` : b<=c ? `${b},${c},${a}` : `${c},${a},${b}`;
}

/** Compare the entire oriented triangle multiset after removing only translation. */
export function matchesSlicedMesh(stl:Uint8Array,native:number[]) {
  const source = stlTriangles(stl);
  if (source.length!==native.length || !source.length) return false;
  const nativeMin=minCorner(native), sourceMin=minCorner(source);
  const buckets=new Map<string,{id:number;point:Point}[]>();
  const byExactPoint=new Map<string,number>();
  const faces=new Map<string,number>();
  const ids:number[]=[];
  for (let i=0;i<native.length;i+=3) {
    const point:Point=[native[i]-nativeMin[0],native[i+1]-nativeMin[1],native[i+2]-nativeMin[2]];
    const exact=point.join(",");
    let id=byExactPoint.get(exact);
    if (id===undefined) {
      id=byExactPoint.size;
      byExactPoint.set(exact,id);
      const cell=point.map(value=>Math.floor(value/toleranceMm)).join(",");
      const group=buckets.get(cell)??[];
      group.push({id,point});
      buckets.set(cell,group);
    }
    ids.push(id);
  }
  for (let i=0;i<ids.length;i+=3) {
    const key=triangleKey(ids[i],ids[i+1],ids[i+2]);
    faces.set(key,(faces.get(key)??0)+1);
  }
  const resolved=new Map<string,number>();
  for (let i=0;i<source.length;i+=9) {
    const triangle:number[]=[];
    for (let j=i;j<i+9;j+=3) {
      const point:Point=[source[j]-sourceMin[0],source[j+1]-sourceMin[1],source[j+2]-sourceMin[2]];
      const exact=point.join(",");
      let id=resolved.get(exact);
      if (id===undefined) {
        const [x,y,z]=point.map(value=>Math.floor(value/toleranceMm));
        for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++) {
          for (const candidate of buckets.get(`${x+dx},${y+dy},${z+dz}`)??[]) {
            if (!candidate.point.every((value,axis)=>Math.abs(value-point[axis])<=toleranceMm)) continue;
            if (id!==undefined) return false;
            id=candidate.id;
          }
        }
        if (id===undefined) return false;
        resolved.set(exact,id);
      }
      triangle.push(id);
    }
    const key=triangleKey(triangle[0],triangle[1],triangle[2]);
    const count=faces.get(key)??0;
    if (!count) return false;
    if (count===1) faces.delete(key);
    else faces.set(key,count-1);
  }
  return faces.size===0;
}
