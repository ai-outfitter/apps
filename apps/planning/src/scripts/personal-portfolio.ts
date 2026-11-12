import { onPageLoad } from "@ai-outfitter/ui/page";
import { CARD_PROJECTS } from "../project-cards";
import { movePortfolioItem } from "../portfolio-order";
type Kind="organizations"|"projects";
type Order={kind:Kind;items:string[];revision:number};
onPageLoad(signal=>{
  const root=document.querySelector<HTMLElement>('[data-project-workspace][data-personal-order="true"]');
  const foundCards=root?.querySelector<HTMLElement>("#project-cards");
  if(!root || !foundCards || root.dataset.projectId)return;
  const cards=foundCards;
  const status=document.createElement("p");status.setAttribute("role","status");status.className="muted";status.dataset.portfolioStatus="";
  cards.before(status);signal.addEventListener("abort",()=>status.remove(),{once:true});
  const endpoint=`${location.pathname.replace(/\/projects(?:\/.*)?$/,"")}/api/apps/planning/portfolio-order`;
  let orders:Record<Kind,Order>|null=null,saving=false;
  let dragged:{kind:Kind;id:string}|null=null;
  const key=(card:HTMLElement)=>card.dataset.organizationKey ?? "";
  const sections=()=>[...cards.querySelectorAll<HTMLElement>(".planning-org-card")];
  const projects=(card:HTMLElement)=>[...card.querySelectorAll<HTMLElement>("[data-order-row]")];
  const scoped=(row:HTMLElement,card:HTMLElement)=>`${key(card)||"personal"}:${row.dataset.orderRow}`;
  function handle(parent:HTMLElement,kind:Kind,id:string,name:string) {
    if(parent.querySelector(`[data-personal-kind="${kind}"]`))return;
    const button=document.createElement("button");button.type="button";button.textContent="⠿";button.className="planning-drag-handle";button.draggable=true;
    button.dataset.personalKind=kind;button.dataset.personalId=id;button.setAttribute("aria-label",`Reorder ${name}`);
    button.title=kind==="projects" ? "Drag within this group; keyboard: move with up or down" : "Drag to reorder; keyboard: move with up or down";
    parent.append(button);
  }
  function arrange(parent:HTMLElement,nodes:HTMLElement[],ids:string[],id:(node:HTMLElement)=>string) {
    const positions=new Map(ids.map((item,index)=>[item,index]));
    const sorted=[...nodes].sort((a,b)=>(positions.get(id(a))??Number.MAX_SAFE_INTEGER)-(positions.get(id(b))??Number.MAX_SAFE_INTEGER));
    if(sorted.some((node,index)=>node!==nodes[index]))for(const node of sorted)parent.append(node);
    return sorted;
  }
  function sync() {
    if(!orders)return;
    const groups=sections();
    arrange(cards,groups,["",...orders.organizations.items],key);
    for(const card of groups) {
      const slug=key(card),header=card.querySelector<HTMLElement>(".planning-org-card-header");
      if(slug && orders.organizations.items.includes(slug) && header)handle(header,"organizations",slug,slug);
      const list=card.querySelector<HTMLElement>(".planning-org-projects");if(!list)continue;
      const sorted=arrange(list,projects(card),orders.projects.items,row=>scoped(row,card));
      const expanded=card.querySelector(".planning-org-toggle")?.textContent?.trim()==="Fewer";
      for(const [index,row] of sorted.entries()) {
        row.hidden=!expanded && index>=CARD_PROJECTS;
        const line=row.querySelector<HTMLElement>(".planning-org-project");
        if(line && orders.projects.items.includes(scoped(row,card)))handle(line,"projects",scoped(row,card),line.querySelector("a")?.textContent ?? "project");
      }
    }
  }
  async function load() {
    status.textContent="Loading your portfolio order…";
    const read=async(kind:Kind)=>{
      const response=await fetch(`${endpoint}?kind=${kind}`,{signal});if(!response.ok)throw new Error("Your portfolio order is unavailable. Reload before reordering.");
      const order=await response.json() as Order;
      if(!Array.isArray(order.items) || !order.items.every(id=>typeof id==="string") || !Number.isInteger(order.revision))throw new Error("Reload the portfolio before reordering.");
      return {...order,kind};
    };
    const [organizations,projects]=await Promise.all([read("organizations"),read("projects")]);if(signal.aborted)return;
    orders={organizations,projects};sync();status.textContent="Your order applies only to you.";
  }
  async function move(kind:Kind,id:string,target:string) {
    if(!orders || saving)return;
    const items=movePortfolioItem(orders[kind].items,id,target);if(!items)return;
    saving=true;status.textContent="Saving your order…";
    try {
      const response=await fetch(endpoint,{method:"POST",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,items,revision:orders[kind].revision})});
      if(!response.ok)throw new Error("Your portfolio changed or could not be saved. Reload before reordering.");
      const saved=await response.json() as Order;if(signal.aborted)return;
      orders[kind]={...saved,kind};sync();status.textContent="Your order is saved.";
    }catch(error){if(!signal.aborted){orders=null;status.textContent=error instanceof Error?error.message:"Unable to save your order.";}}
    finally{saving=false;}
  }
  const target=(event:DragEvent,kind:Kind)=>{
    const card=(event.target as Element).closest<HTMLElement>(".planning-org-card");if(!card)return;
    if(kind==="organizations")return key(card)||undefined;
    const row=(event.target as Element).closest<HTMLElement>("[data-order-row]");return row?scoped(row,card):undefined;
  };
  cards.addEventListener("dragstart",event=>{
    const button=(event.target as Element).closest<HTMLElement>("[data-personal-kind]");
    if(!button || !orders || saving)return;
    dragged={kind:button.dataset.personalKind as Kind,id:button.dataset.personalId!};event.dataTransfer?.setData("text/plain",dragged.id);
  },{signal});
  const compatible=(id:string|undefined)=>id && dragged && (dragged.kind==="organizations" || id.split(":")[0]===dragged.id.split(":")[0]);
  cards.addEventListener("dragover",event=>{if(dragged && compatible(target(event,dragged.kind)))event.preventDefault();},{signal});
  cards.addEventListener("drop",event=>{if(!dragged)return;const destination=target(event,dragged.kind),source=dragged;dragged=null;
    if(destination && (source.kind==="organizations" || destination.split(":")[0]===source.id.split(":")[0])){event.preventDefault();void move(source.kind,source.id,destination);}
  },{signal});
  cards.addEventListener("dragend",()=>{dragged=null;},{signal});
  cards.addEventListener("keydown",event=>{
    const button=(event.target as Element).closest<HTMLElement>("[data-personal-kind]");if(!button || !["ArrowUp","ArrowDown"].includes(event.key))return;
    const kind=button.dataset.personalKind as Kind,card=button.closest<HTMLElement>(".planning-org-card");if(!card)return;
    const visible=kind==="organizations" ? sections().map(key).filter(Boolean) : projects(card).map(row=>scoped(row,card));
    const id=button.dataset.personalId!,next=visible[visible.indexOf(id)+(event.key==="ArrowUp"?-1:1)];if(next){event.preventDefault();void move(kind,id,next);}
  },{signal});
  const observer=new MutationObserver(sync);observer.observe(cards,{childList:true,subtree:true});signal.addEventListener("abort",()=>observer.disconnect(),{once:true});
  void load().catch(error=>{if(!signal.aborted)status.textContent=error instanceof Error?error.message:"Personal order unavailable.";});
});
