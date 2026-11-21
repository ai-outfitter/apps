// Keep the last working set per installation. IndexedDB preserves the worker's
// structured mesh arrays without serializing them into strings on the UI thread.
import type { MeshReply } from "./assembly-viewer";

type Entry = {engine:string; meshes:Map<string,MeshReply>};

export async function openMeshCache():Promise<IDBDatabase | undefined> {
  try {
    return await new Promise((resolve,reject)=>{
      const request=indexedDB.open("workshop-render-cache",1);
      request.onupgradeneeded=()=>request.result.createObjectStore("meshes");
      request.onsuccess=()=>{
        request.result.onversionchange=()=>request.result.close();
        resolve(request.result);
      };
      request.onerror=()=>reject(request.error);
    });
  } catch { return undefined; }
}

export function readMeshes(db:IDBDatabase | undefined,key:string,engine:string):Promise<Map<string,MeshReply>> {
  return new Promise(resolve=>{
    if (!db) return resolve(new Map());
    try {
      const request=db.transaction("meshes").objectStore("meshes").get(key);
      request.onsuccess=()=>{
        const entry:Entry|undefined=request.result;
        resolve(entry?.engine===engine && entry.meshes instanceof Map ? entry.meshes : new Map());
      };
      request.onerror=()=>resolve(new Map());
    } catch { resolve(new Map()); }
  });
}

export function storeMeshes(db:IDBDatabase | undefined,key:string,entry:Entry) {
  if (!db) return;
  try {
    db.transaction("meshes","readwrite").objectStore("meshes").put(entry,key);
  } catch { /* Rendering also works when browser storage is unavailable. */ }
}
