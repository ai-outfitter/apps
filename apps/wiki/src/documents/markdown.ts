import {micromark} from "micromark";

type Fence={character:string;length:number}|null;
function fenceAfter(line:string,current:Fence):Fence {
 const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
 if(!marker)return current;
 if(current)return marker[1][0]===current.character && marker[1].length>=current.length && !marker[2].trim()?null:current;
 // Backticks in an opening backtick fence's info string are not CommonMark fences.
 return marker[1][0]==="`" && marker[2].includes("`")?null:{character:marker[1][0],length:marker[1].length};
}
const escape=(text:string)=>text.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");

/** Render exact top-level details wrappers; everything else retains micromark's safe HTML/link defaults. */
export function generatedMarkdown(source:string):string {
 const lines=source.split(/\r?\n/);
 let output="",start=0,fence:Fence=null;
 for(let index=0;index<lines.length;index++){
  const summary=!fence && lines[index]==="<details>"?/^<summary>([^<>]*)<\/summary>$/.exec(lines[index+1]??""):null;
  if(!summary){fence=fenceAfter(lines[index],fence);continue;}
  let end=index+2,bodyFence:Fence=null;
  for(;end<lines.length;end++){
   if(!bodyFence && lines[end]==="</details>")break;
   bodyFence=fenceAfter(lines[end],bodyFence);
  }
  // Do not rescan the rest for each unclosed opener.
  if(end===lines.length)break;
  output+=micromark(lines.slice(start,index).join("\n"));
  output+=`<details><summary>${escape(summary[1])}</summary>${micromark(lines.slice(index+2,end).join("\n"))}</details>`;
  index=end;start=end+1;
 }
 return output+micromark(lines.slice(start).join("\n"));
}
