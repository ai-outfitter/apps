import { AssemblySchema, type Assembly } from "../lib/assembly";
import { powerRollup } from "../lib/power";
const node=(tag:string,text="")=>{const n=document.createElement(tag);n.textContent=text;return n;};
const fmt=(v:number|null,unit="W")=>v===null?"Unknown":`${v.toLocaleString(undefined,{maximumFractionDigits:2})} ${unit}`;
function powerTable(caption: string, columns: string[]) {
 const table = document.createElement("table");
 table.className = "power-table";
 table.createCaption().textContent = caption;
 const header = table.createTHead().insertRow();
 for (const name of columns) {
  const th = document.createElement("th");
  th.scope = "col";
  th.textContent = name;
  header.append(th);
 }
 const body = table.createTBody();
 function addRow(cells: HTMLElement[]) {
  const row = body.insertRow();
  cells.forEach((cell, index) => {
   if (index > 0) {
    const label = node("span", columns[index]);
    label.className = "power-field-label";
    cell.prepend(label);
   }
   row.append(cell);
  });
 }
 return {table, addRow};
}
/** Power follows the viewed item; saved inputs belong to the full assembly. */
export function renderPowerPanel(host:HTMLElement,assembly:Assembly,itemId:string|undefined,save?: (next:Assembly)=>Promise<void>,editableItems?:Set<string>){
 const focused = itemId !== assembly.rootId && assembly.items.find(item => item.id === itemId);
 host.replaceChildren(node("h2", focused ? `Power · ${focused.name}` : "Power"));
 if(!assembly.power){host.append(node("p","No power budget saved with this assembly. Missing data is not zero demand."));return;}
 const model=assembly.power;
 const select=document.createElement("select");select.id="power-scenario";select.setAttribute("aria-label","Power scenario");
 for(const s of model.scenarios)select.add(new Option(s.name,s.id));
 host.append(select);
 const content=node("div");host.append(content);
 const render=()=>{try{
  const result=powerRollup(assembly,select.value,itemId);
  if(!result)throw Error("Choose a root assembly before calculating power");
  content.replaceChildren();
  const scenario=model.scenarios.find(s=>s.id===select.value)!;
  content.append(node("p",scenario.notes));
  const summary=node("p",result.rows.length?`Source-equivalent demand at ${result.boundary.name}: ${fmt(result.total.operatingW)} operating · ${fmt(result.total.averageW)} 24-hour average · ${fmt(result.total.peakW)} simultaneous running peak · ${fmt(result.dailyWh,"Wh/day")}`:"No loads recorded in this component. This does not establish zero consumption.");summary.id="power-summary";
  content.append(summary,node("p","Totals describe one instance of this assembly, including its child quantities. Rail rows include their downstream demand and must not be added together. Peak excludes unrecorded startup surges."));
  if(!result.rows.length)return;
  content.append(node("p",`${result.unrecorded} placed parts have no direct load record (mechanical parts may need none). Only recorded loads are included.`));
  const rails = powerTable("Supply rails — downstream demand and conversion losses included",
   ["Rail", "24-hour average", "Operating", "Running peak", "Peak DC current"]);
  for (const r of result.rails) {
   const current = r.kind === "dc" ? fmt(r.values.peakW === null ? null : r.values.peakW / r.voltage, "A") : "Requires power factor";
   rails.addRow([`${r.name} (${r.voltage} V ${r.kind.toUpperCase()})`, fmt(r.values.averageW),
    fmt(r.values.operatingW), fmt(r.values.peakW), current].map(value => node("td", value)));
  }
  const wrap=node("div");wrap.className="power-scroll";wrap.append(rails.table);content.append(wrap);
  const form=document.createElement("form");
  const loads = powerTable("Component input loads — values per part instance; quantity applied in totals",
   ["Component / load", "Qty", "Input rail", "Average W", "Operating W", "Peak W", "Evidence"]);
  const edits:{itemId:string;loadId:string;inputs:HTMLInputElement[]}[]=[];
  for(const row of result.rows){
   const title=node("td",`${row.itemName} · ${row.load.name}`);title.append(node("small",row.number),node("small",row.load.notes));
   const cells = [title, node("td", String(row.quantity)), node("td", row.load.rail)];
   const inputs:HTMLInputElement[]=[];
   for(const field of ["averageW","operatingW","peakW"] as const){
    const td=node("td"),input=document.createElement("input");input.type="number";input.min="0";input.step="any";input.placeholder="Unknown";input.value=row.load.scenarios[select.value][field]?.toString()??"";input.disabled=!save || Boolean(editableItems && !editableItems.has(row.itemId));input.setAttribute("aria-label",`${row.number} ${row.load.name} ${field}`);inputs.push(input);td.append(input);cells.push(td);
   }
   const evidence=node("td",row.load.evidence);evidence.append(node("small",row.load.source));cells.push(evidence);loads.addRow(cells);if (!editableItems || editableItems.has(row.itemId)) edits.push({itemId:row.itemId,loadId:row.load.id,inputs});
  }
  const scroll=node("div");scroll.className="power-scroll";scroll.append(loads.table);form.append(scroll);
  const status=node("p");status.id="power-save-status";status.setAttribute("role","status");
  if(save && edits.length){
   const button=node("button","Save power values") as HTMLButtonElement;button.type="submit";form.append(button);
   form.onsubmit=async e=>{e.preventDefault();button.disabled=true;try{
    const next=structuredClone(assembly);
    for(const edit of edits){const load=next.items.find(i=>i.id===edit.itemId)!.power!.loads.find(l=>l.id===edit.loadId)!;
     const values=edit.inputs.map(i=>i.value===""?null:Number(i.value));
     load.scenarios[select.value]={averageW:values[0],operatingW:values[1],peakW:values[2]};
    }
    await save(editableItems ? next : AssemblySchema.parse(next));assembly=next;render();
   }catch(error){status.textContent=(error as Error).message;button.disabled=false;}};
  }else if(editableItems)form.append(node("p","Edit referenced loads in their source project."));
  else if(!save)form.append(node("p","Historical build or demo: power values are read-only."));
  form.append(status);content.append(form);
  const details=node("details");details.append(node("summary","Assumptions and supply connections"),node("p",model.notes));
  for(const r of model.rails)details.append(node("p",`${r.name}: ${r.parent?`supplied by ${r.parent}, ${(r.efficiency*100).toFixed(1)}% conversion efficiency`:"source boundary"}. ${r.notes}`));
  content.append(details);
 }catch(error){content.replaceChildren(node("p",`Power budget unavailable: ${(error as Error).message}`));}};
 select.onchange=render;render();
}
