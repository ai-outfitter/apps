import {onPageLoad} from "@ai-outfitter/ui/page";
import {organizationOriginForAppHost} from "@ai-outfitter/server/hosts";
onPageLoad(()=>{
 const link=document.getElementById("org");
 if(!(link instanceof HTMLAnchorElement))return;
 const mounted=/^\/o\/([^/]+)\//.exec(location.pathname);
 const origin=mounted?`${location.origin}/o/${mounted[1]}`:location.pathname.startsWith("/apps/")?null:organizationOriginForAppHost("wiki-map",location);
 link.hidden=!origin;
 if(origin)link.href=origin; else link.removeAttribute("href");
});
