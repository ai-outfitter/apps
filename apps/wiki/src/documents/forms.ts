import {onPageLoad} from "@ai-outfitter/ui/page";

if(import.meta.env.OUTFITTER_APP_MODE === "operational") onPageLoad(signal=>{
 for(const form of document.querySelectorAll<HTMLFormElement>("form[data-wiki-form]")) {
  form.addEventListener("submit",async event=>{
   event.preventDefault();event.stopImmediatePropagation();
   const fields=Object.fromEntries(new FormData(form));
   const operation=String(fields.operation);delete fields.operation;
   if(fields.revision)fields.revision=Number(fields.revision) as never;
   if(fields.slug==="")delete fields.slug;
   if(operation==="SavePage"&&typeof fields.entityRef==="string")fields.entityRef=JSON.parse(fields.entityRef);
   const button=form.querySelector<HTMLButtonElement>("button[type=submit],button:not([type])");
   if(button)button.disabled=true;
   let notice=form.querySelector<HTMLElement>("[role=alert]");
   if(!notice){notice=document.createElement("p");notice.setAttribute("role","alert");form.append(notice);}
   notice.textContent="";
   try {
    const response=await fetch(form.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation,variables:{input:fields}}),signal});
    if(!response.ok)throw new Error(await response.text());
    const result=await response.json() as Record<string,{id:string}>;
    const record=Object.values(result)[0];
    if(!record?.id)throw new Error("The document response was incomplete. Refresh before retrying.");
    if(!signal.aborted)location.assign(`${form.dataset.wikiRoot}p/${encodeURIComponent(record.id)}`);
   }catch(error){if(!signal.aborted)notice.textContent=error instanceof Error?error.message:"The document could not be saved.";}
   finally{if(button)button.disabled=false;}
  },{signal,capture:true});
 }
});
