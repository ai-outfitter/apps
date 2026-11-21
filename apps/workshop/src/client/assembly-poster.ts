import { projectThumbnail } from "../lib/thumbnail";
import type { Project } from "../lib/project";
import type { Assembly } from "../lib/assembly";
import { appBase } from "../lib/sections";

/** Display only after reading the authorized view and its resolved source revisions. */
export function assemblyPoster(host:HTMLElement) {
  const storageKey="workshop-poster:"+appBase(location.pathname);
  let generation=0;
  return {
    show(project:Project, view:Assembly, key:string, savedCapture?:string) {
      const current=++generation;
      host.hidden=false;
      const drawing=new DOMParser().parseFromString(projectThumbnail({...project,assembly:view}),"image/svg+xml").documentElement;
      drawing.setAttribute("aria-label","Static assembly outline");
      drawing.setAttribute("role","img");
      host.replaceChildren(drawing);
      let cached=false;
      try {
        const saved=JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        const prefix="data:image/jpeg;base64,";
        if(saved?.key===key && typeof saved.image==="string" && saved.image.startsWith(prefix)) {
          const bytes=Uint8Array.from(atob(saved.image.slice(prefix.length)),char=>char.charCodeAt(0));
          cached=true;
          void createImageBitmap(new Blob([bytes],{type:"image/jpeg"})).then(bitmap=>{
            try {
              if(current!==generation || host.hidden)return;
              const poster=document.createElement("canvas");
              poster.width=bitmap.width;poster.height=bitmap.height;
              poster.setAttribute("role","img");
              poster.setAttribute("aria-label","Saved assembly snapshot");
              poster.getContext("2d")!.drawImage(bitmap,0,0);
              host.replaceChildren(poster);
            } finally { bitmap.close(); }
          }).catch(()=>{cached=false;});
        }
      } catch { cached=false; }
      if(!cached && savedCapture){
        const image=new Image();
        image.alt="Static assembly preview";
        image.onload=()=>{if(current===generation && !host.hidden)host.replaceChildren(image);};
        image.src=savedCapture;
      }
      return (capture?:()=>string)=>{
        if(current!==generation)return;
        host.hidden=true;
        if(!cached && capture)try {
          sessionStorage.setItem(storageKey,JSON.stringify({key,image:capture()}));
        } catch { /* Snapshotting is optional when memory or storage is limited. */ }
      };
    },
  };
}
